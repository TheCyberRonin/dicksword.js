'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const gateway_version = '6';
const EventEmitter = require('events').EventEmitter;
const Zlib = require('zlib');
const URL = require('url');
const got = require('got');


const CLOSE_CODES = {
  4000: {description: 'Unkown error', explaination: 'We\'re not sure what went wrong. Try reconnecting?'},
  4001: {description: 'Unkown opcode', explaination: 'You sent an invalid Gateway opcode. Don\'t do that!'},
  4002: {description: 'Decode error', explaination: '	You sent an invalid payload to us. Don\'t do that!'},
  4003: {description: 'Not authenticated', explaination: 'You sent us a payload prior to identifying.'},
  4004: {description: 'Authenticaion failed', explaination: 'The account token sent with your identify payload is incorrect.'},
  4005: {description: 'Already authenticated', explaination: 'You sent more than one identify payload. Don\'t do that!'},
  4007: {description: 'Invalid seq', explaination: 'The sequence sent when resuming the session was invalid. Reconnect and start a new session.'},
  4008: {description: 'Rate limited', explaination: 'Woah nelly! You\'re sending payloads to us too quickly. Slow it down!'},
  4009: {description: 'Session timeout', explaination: 'Your session timed out. Reconnect and start a new one.'},
  4010: {description: 'Invalid shard', explaination: 'You sent us an invalid shard when identifying.'},
  4011: {description: 'Sharding required', explaination: 'The session would have handled too many guilds - you are required to shard your connection in order to connect.'}
};


/**
 * Constructor for the Client class
 * @param {Object} settings - Object that holds the settings for the Client
 * @param {String} settings.token - Token for bot or user
 * @param {Object} [settings.game] - Game option of the presence to set on startup
 * @param {Object} [settings.status] - Optional status to set
 * @param {Boolean} [settings.autorun] - Decides whether or not the bot will automatically start
 * @param {Number} [settings.cacheOfflineUsers] - Boolean to decide whether or not to cache offline users right from the start
 */
class Client extends EventEmitter
{
  constructor(settings)
  {
    super();
    if(!settings.token) new Error(`You don't have a token`);
    settings.status ? this.checkStatus(settings.status): this.status = 'online';
    this.internals = {};
    this.internals.token = settings.token;
    this._messageCacheLimit = settings.messageCacheLimit || 50;
    this.cacheOfflineUsers = settings.cacheOfflineUsers || false;
    this.servers = {};
    this.channels = {};
    this.users = {};
    this.directMessages = {};
    this.bot = false;
    this.ping = 0;
    this.internals.sequence = null;
    this.lastPresence = {
      game: settings.game ? 
      {
        name: settings.game.name,
        type: settings.game.type || settings.game.url ? 1 : 0, url: settings.game.url || null
      } : {},
      status: this.status,
      afk: false
    };
    this.setPresence = this.setPresence.bind(this);
    this._handleIdentify = this._handleIdentify.bind(this);
    this.setEndpoints();
    if(settings.autorun)
    {
      this.connect();
    }
  }
  /**
   * Checks to see if the user entered a valid status to be sent
   * @returns {String} - If valid, returns the status. If invalid, returns online
   */
  checkStatus(string)
  {
    let acceptable = [
      'online',
      'dnd',
      'idle',
      'invisible',
      'offline'
    ];
    if(acceptable.indexOf(string) !== -1)
    {
      this.status = string;
      return(string);
    }
    else
    {
      this.status = 'online';
      return('online');
    }
  }
  /**
   * Handles connecting to Discord via websocket
   */
  connect()
  {
    this.getGatewayInfo().then((gateway) =>
    {
      this.emit('debug', gateway);
      this.internals.gateway = gateway;
      this._connect(gateway);
    }).catch((err) =>
    {
      this.reconnect();
      return this.emit('debug', 'Error getting gateway: ' + err);
    });
  }
  /**
   * Handles reconnecting to the websocket (this is what should be called in the client if you want to reconnect)
   */
  reconnect()
  {
    setTimeout(() =>
    {
      if(!this.DiscordWebSocket)
      {
        setTimeout(() => {this.connect();}, 3000);
      }
      else
      {
        this.handleWSClose(1006);
      }
    },8000);

  }
  /**
   * Sets the presence of the bot
   */
  setPresence(presence)
  {
    let currentPresence = this.lastPresence;
    let wsSend = this.wsSend.bind(this);
    let PAYLOADS = this.PAYLOADS;
    return new Promise((resolve, reject) =>
    {
      currentPresence.game = {
        name: presence.game.name ? presence.game.name : reject('The object needs a name member.'),
        type: presence.game.type ? (presence.game.url ? 1 : 0) : 0,
        url: presence.game.url || null
      };
      currentPresence.status = presence.status !== undefined ? this.checkStatus(presence.status) : 'online';
      wsSend(PAYLOADS.STATUS(currentPresence));
      resolve(true);
    });

  }
  /**
   * Sets the endpoints for accessing Discord
   */
  setEndpoints()
  {
    //set endpoints
    let DiscordAPI = 'https://discordapp.com/api';
    let DiscordCDN = 'https://cdn.discordapp.com';
    let ME = DiscordAPI + '/users/@me';

    this.ENDPOINTS = {
      API: DiscordAPI,
      CDN: DiscordCDN,
      ME: ME,
      LOGIN: DiscordAPI + '/auth/login',
      OAUTH: DiscordAPI + '/oauth2/applications/@me',
      GATEWAY: DiscordAPI + '/gateway',
      SETTINGS: ME + '/settings',
      NOTE: (userID) => {return ME + '/notes/' + userID;},
      SERVERS: (serverID) => {return `${DiscordAPI}/guilds${serverID ? '/' + serverID : ''}`;},
      SERVERS_USER: (serverID) => {return `${this.ENDPOINTS.ME()}/guilds${serverID ? '/' + serverID : ''}`;},
      SERVER_EMOJIS: (serverID, emojiID) => {return `${this.ENDPOINTS.SERVERS(serverID)}/emojis${emojiID ? '/' + emojiID: ''}`;},
      CHANNEL: (channelID) => {return DiscordAPI + '/channels/' + channelID;},
      MEMBERS: (serverID, userID) => {return `${this.ENDPOINTS.SERVERS(serverID)}/members${userID ? '/' + userID : ''}`;},
      MEMBER_ROLES: (serverID, userID, roleID) => {return `${this.ENDPOINTS.MEMBERS(serverID, userID)}/roles${roleID ? '/' + roleID : ''}`;},
      USER: (userID) => {return DiscordAPI + /users/ + userID;},
      ROLES: (serverID, roleID) => {return `${this.ENDPOINTS.SERVERS(serverID)}/roles${roleID ? '/' + roleID : ''}`;},
      BANS: (serverID, userID) => {return `${this.ENDPOINTS.SERVERS(serverID)}/bans${userID ? '/' + userID : ''}`;},
      MESSAGES: (channelID, messageID) => {return `${this.ENDPOINTS.CHANNEL(channelID)}/messages${messageID ? '/' + messageID : ''}`;},
      PINNED_MESSAGES: (channelID, messageID) => {return `${this.ENDPOINTS.CHANNEL(channelID)}/pins${messageID ? '/' + messageID : ''}`;},
      MESSAGE_REACTIONS: (channelID, messageID, reaction) => {return `${this.ENDPOINTS.MESSAGES(channelID, messageID)}/reactions${reaction ? '/' + reaction : ''}`;},
      USER_REACTIONS: (channelID, messageID, reaction, userID) => {return `${this.ENDPOINTS.MESSAGE_REACTIONS(cannelID, messageID, reaction)}/${!userID || userID === this.id ? '@me' : userID}`;},
      INVITES: (inviteCode) => {return DiscordAPI + '/invite' + inviteCode;},
      SERVER_WEBHOOKS: (serverID) => {return `${this.ENDPOINTS.SERVERS(serverID)}/webhooks`;},
      CHANNEL_WEBHOOKS: (channelID) => {return `${this.ENDPOINTS.CHANNEL(channelID)}/webhooks`;},
      WEBHOOKS: (webhookID) => {return DiscordAPI + '/webhooks/' + webhookID;},
      BULD_DELETE: (channelID) => {return `${this.ENDPOINTS.CHANNEL(channelID)}/messages/bulk-delete`;},
      TYPING: (channelID) => {return `${this.ENDPOINTS.CHANNEL(channelID)}/typing`;}
    };
  }
  /**
   * Gets the gateway info from Discord
   * @returns {Promise<string>} - Full URL to access the gateway for the websocket connection to Discord
   */
  getGatewayInfo()
  {
    return new Promise((resolve, reject) =>
    {
      this._APIcall('get', this.ENDPOINTS.GATEWAY).then((response) =>
      {
        resolve(response.body.url + '/?encoding=json&v=' + gateway_version);
      }).catch((err) =>
      {
        this.emit('debug', err);
        reject(err);
      });
    });
  }
  /**
   * Connects to Discod via websocket
   * @param {string} gateway - URL for connecting to Discord via websocket
   */
  _connect(gateway)
  {
    this.init();
    this.DiscordWebSocket = new WebSocket(gateway);
    //handle close on close, and error
    this.DiscordWebSocket.once('close', this.handleWSClose.bind(this));
    this.DiscordWebSocket.once('error', this.handleWSClose.bind(this));
    this.DiscordWebSocket.on('message', this.handleWS.bind(this));
  }
  /**
   * Sets the headers for API calls to Discord
   * @returns {object}
   */
  setHeaders()
  {
    return {
      'accept': '*/*',
      'accept-language': 'en-US;q=0.8',
      'accept-encoding': 'gzip, deflate',
      'user_agent': 'Discord Bot (dicksword.js)',
      'dnt': 1,
      'Authorization': (this.bot ? 'Bot ' : '') + this.internals.token
    };
  }
  /**
   * Initializes some internals and creates the payloads to send to Discord
   */
  init()
  {
    let internals = this.internals;
    //setup HB
    internals._lastHB = 0;
    /*
    This is based of off https://github.com/izy521/discord.io's Payloads with modifications
    */
    this.PAYLOADS = {
      IDENTIFY: {
        op: 2,
        d: {
          token: internals.token,
          properties: {
            $os: process.platform,
            $browser: 'dickswordjs',
            $device: 'dickswordjs'
          },
          compress: true,
          large_threshold: 250,
          shard: [0,1],
          presence: this.lastPresence
        }
      },
      RESUME: {
        op: 6,
        d: {
          token: internals.token,
          session_id: internals.sessionID,
          seq: internals.sequence
        }
      },
      HEARTBEAT: () => 
      {
        return  {
          op: 1,
          d: internals.sequence
        };
      },
      ALL_USERS: {op: 12, d: Object.keys(this.servers)},
      STATUS: (statusObj) =>
      {
        return {
          op: 3,
          d: {
            status: typeof(statusObj.idle_since) === 'number' ? 'idle' : statusObj.status !== undefined ? statusObj.status : null,
            afk: statusObj.afk !== null ? statusObj.afk : false,
            since: typeof(statusObj.idle_since) === 'number' || statusObj.status === 'idle' ? Date.now() : null,
            game: typeof(statusObj.game) === 'object' ?
            {
              name: statusObj.game.name ? String(statusObj.game.name) : null,
              type: statusObj.game.type,
              url: statusObj.game.url
            } :
              null
          }
        };
      },
      UPDATE_VOICE: (serverID, channelID) =>
      {
        return {
          op: 4,
          d: {
            guild_id: serverID,
            channel_id: channelID,
            self_mute: false,
            self_deaf: false
          }
        };
      },
      REQUEST_OFFLINE_MEMBERS: (serverID) =>
      {
        return {
          op: 8,
          d: {
            guild_id: serverID,
            query: '',
            limit: 0
          }
        };
      },
      VOICE_SPEAK: (voice) =>
      {
        return {op: 5, d: {speaking: !!v, delay: 0}};
      },
      VOICE_IDENTIFY: (ip, port, mode) =>
      {
        return {
          op: 1,
          d: {
            protocol: 'udp',
            data: {
              address: ip,
              port: Number(port),
              mode: mode
            }
          }
        };
      }
    };
  }
  /**
   * Handles the payloads from the websocket connection
   * @param {object} data - payload from the websocket connection 
   */
  handleWS(data)
  {
    let wsPayload = this.processWS(data);
    //debug
    this.emit('debug', `wsPayload in handleWS ${JSON.stringify(wsPayload)}`);
    let wsData = wsPayload.d;
    wsPayload.op !== 11 ? this.internals.sequence = wsPayload.s : '';

    switch(wsPayload.op)
    {
    case 10:
      this._handleIdentify();
      this._keepAlive = setInterval(() =>
      {
        this.internals._lastHB = Date.now();
        this.wsSend(this.PAYLOADS.HEARTBEAT());
      }, wsData.heartbeat_interval);
      break;
    case 11:
      this.ping = (Date.now() - this.internals._lastHB);
      //debug
      this.emit('debug', `IN HB: ~~~~ ${Date.now() - this.internals._lastHB}`);
      break;
    }

    this.emit('any', wsPayload);
    switch(wsPayload.t)
    {
    case 'READY':
      //debug
      this.emit('debug', `READY YEEEE ${JSON.stringify(wsPayload.t)}`);
      this.internals.sessionID = wsData.session_id;
      Object.assign(this, wsData.user);
      this.inviteURL = `https://discordapp.com/oauth2/authorize?client_id=${this.id}&scope=bot`;
      this.handleOauth();
      this.handleGuilds(wsData.guilds);
      this.handleDMs(wsData.private_channels);
      this.emit('ready');
      break;
    case 'MESSAGE_CREATE':
      this.emit('message', new Message(wsData, this));
      break;
    case 'GUILD_CREATE':
      this.servers[wsData.id] = new Server(wsData, this);
      this.cacheOfflineUsers ? this._checkOfflineMembers(wsData.id) : '';
      this.emit('guildCreate', this.servers[wsData.id]);
      break;
    case 'GUILD_ROLE_UPDATE':
      this.servers[wsData.guild_id].roles[wsData.role.id] = wsData.role;
      this.emit('roleUpdate', wsData);
      break;
    case 'GUILD_MEMBER_ADD':
      this.servers[wsData.guild_id].members[wsData.user.id] = new Member(wsData);
      this.servers[wsData.guild_id].member_count++;
      this.users[wsData.user.id] ? this.users[wsData.user.id].referenceCount++ : this.users[wsData.user.id] = new User(wsData.user);
      this.emit('guildMemberAdd', this.servers[wsData.guild_id].members[wsData.user.id]);
      break;
    case 'GUILD_MEMBER_REMOVE':
      delete(this.servers[wsData.guild_id].members[wsData.user.id]);
      this.servers[wsData.guild_id].member_count --;
      if(this.users[wsData.user.id])
      {
        this.users[wsData.user.id].referenceCount --;
        if(this.users[wsData.user.id].referenceCount === 0)
        {
          delete(this.users[wsData.user.id]);
        }
      }
      this.emit('guildMemberRemove', wsData);
      break;
    case 'GUILD_MEMBER_UPDATE':
      this.servers[wsData.guild_id].members[wsData.user.id].update(wsData, this);
      this.emit('guildMemberUpdate', wsData);
      break;
    case 'RECONNECT':
      this.handleWSClose(1006);
      break;
    case 'GATEWAY_INVALID_SESSION':
      !wsData ? this.internals.sessionID = null : '';
      this.handleWSClose(1006);
      break;
    case 'GUILD_MEMBERS_CHUNK':
      this.handleGuildChunk(wsData);
      break;
    }
  }
  /**
   * Handles the chunk of users and will cache them appropriately in the guild and cached users
   * @param {Object} chunk - Guild chunk from Discord docs 
   */
  handleGuildChunk(chunk)
  {
    let server = this.servers[chunk.guild_id];
    let users = this.users;
    let userID;
    let arrLen = chunk.members.length;
    this.emit('debug', `${arrLen} Users in offline guild chunk`);
    for(let i = 0; i < arrLen; i ++)
    {
      userID = chunk.members[i].user.id;
      if(!server.members[userID]) 
      {
        users[userID] ? users[userID].referenceCount++ : users[userID] = chunk.members[i].user;
        server.members[userID] = new Member(chunk.members[i]);
      }
    }
  }
  /**
   * Gets the Oauth information associated with the bot
   */
  handleOauth()
  {
    this._APIcall('get', this.ENDPOINTS.OAUTH).then((oauth) =>
    {
      this.internals.oauth = oauth;
    }).catch((err) =>
    {
      emit('debug', err);
    });
  }
  /**
   * Sends a message to a specified channel
   * @param {string} channelID - ID of the channel you want to send a message to
   * @param {string|object} message - Can be either a string or an object
   * @returns {Promise<object>} - message response
   */
  sendMessage(channelID, message)
  {
    return new Promise((resolve, reject) =>
    {
      let messageObj = {};
      if(typeof message === 'string' || typeof message === 'number')
      {
        messageObj.content = message;
        messageObj.embed = arguments[2] ? arguments[2].embed : {};
      }
      else
      {
        messageObj.content = message.content  !== undefined ? message.content : '';
        messageObj.embed = message.embed ? message.embed : {};
      }
      //this.emit('debug', messageObj);
      this._APIcall('post', this.ENDPOINTS.MESSAGES(channelID), messageObj).then((result) =>
      {
        resolve(new Message(result.body, this));
      }).catch((err) =>
      {
        reject(err);
      });
    }); 
  }
  /**
   * This will go through all of the servers and decide if there are members that are offline, but not in cache
   * It will request offline users for the servers that aren't caught up yet
   * This will set a short timeout per request sent
   */
  getAllOfflineMembers()
  {
    if(this.cacheOfflineUsers) return;
    this.cacheOfflineUsers = true;
    Object.keys(this.servers).forEach((serverID) =>
    {
      let server = this.servers[serverID];
      server.members ? ((Object.keys(server.members).length !== server.member_count) && server.large) ?
        setTimeout(() => {this._getOfflineMembers(serverID);}, 250)
      : ''
      : '';
    });
  }
  /**
   * Internal helper for checking offline users, will check to see if you need ot check for offline members
   * @param {String} serverID 
   */
  _checkOfflineMembers(serverID)
  {
    let server = this.servers[serverID];
    server.members ? ((Object.keys(server.members).length !== server.member_count) && server.large) ?
      this._getOfflineMembers(serverID)
      : ''
      : '';
  }
  /**
   * Internal helper for checking offline users, this sends the actual request
   * @param {String} serverID 
   */
  _getOfflineMembers(serverID)
  {
    this.wsSend(this.PAYLOADS.REQUEST_OFFLINE_MEMBERS(serverID));
  }
  /**
   * Handles the DMs from a READY payload
   * @param {array} dmArr - Array of DM channels
   */
  handleDMs(dmArr)
  {
    let arrLen = dmArr.length;
    for(let i = 0; i < arrLen; i ++)
    {
      this.directMessages[dmArr[i].id] = new DirectMessage(dmArr[i]);
    }
  }
  /**
   * Handles the guilds from the READY payload
   * @param {array} guildArr 
   */
  handleGuilds(guildArr)
  {
    let arrLen = guildArr.length;
    for(let i = 0; i < arrLen; i++)
    {
      this.servers[guildArr[i].id] = new Server(guildArr[i]);
    }
  }
  /**
   * Handles the closing of the websocket connection
   * @param {number} code - Error code 
   * @param {object} data - Data provided
   */
  handleWSClose(code, data)
  {
    let errMessage = CLOSE_CODES[code] !== undefined ? CLOSE_CODES[code].description : 'Unkown';
    this.emit('debug', `Data in wsClose ${data}`);
    //kill main keepalive loop
    clearInterval(this._keepAlive);
    if(this.DiscordWebSocket)
    {
      this.DiscordWebSocket.removeAllListeners('message');
    }
    
    this.DiscordWebSocket = null;
    if(code === (1006 || 1001))
    {
      this.emit('debug', `${code} in err check for handleWSClose`);
      return this.reconnect();
    }
    else if(code === 1000)
    {
      this.emit('debug', `${code} in err check for handleWSClose`);
      this.internals.sessionID = null;
      return this.reconnect();
    }

    this.emit('disconnect', errMessage, code);
  }
  /**
   * Handles any API call to Discord
   * @param {string} method - Method to use 
   * @param {string} url - URL for the API to use
   * @returns {Promise<object>} - Response from the API call
   */
  _APIcall(method, url)
  {
    return new Promise((resolve, reject) =>
    {
      let data = arguments[2] !== undefined ? arguments[2] : undefined, req, callOptions;
      callOptions = URL.parse(url);
      callOptions.method = method.toUpperCase();
      callOptions.headers = this.setHeaders();
      callOptions.json = true;
      callOptions.retries = 2;
      if(data)
      {
        callOptions.body = data;
        callOptions.headers['content-type'] = 'application/json';
      }
      this.emit('debug', '~~~~sending~~~~');
      got(url, callOptions).then((result) =>
      {
        this.emit('debug', '~~~~sent~~~~');
        resolve(result);
      }).catch((err) =>
      {
        reject(err);
      });
    });
  }
  /**
   * Handles a payload from a websocket message
   * @param {object} message - Payload from a websocket message
   */
  processWS(message)
  {
    return message instanceof Buffer ? JSON.parse(Zlib.inflateSync(message).toString()) : JSON.parse(message);
  }
  /**
   * Sends data through the websocket
   * @param {object} data - Data to send 
   */
  wsSend(data)
  {
    this.emit('debug', `DATA IN SEND ${JSON.stringify(data)}`);
    if(this.DiscordWebSocket && this.DiscordWebSocket.readyState === 1)
    {
      this.DiscordWebSocket.send(JSON.stringify(data));
    }
  }
  /**
   * Decides whether or not to resume or identify to Discord
   */
  _handleIdentify()
  {
    let PAYLOADS = this.PAYLOADS;
    let internals = this.internals;
  
    this.emit('debug', `In _handleIdentify ${JSON.stringify(internals.sessionID ? PAYLOADS.RESUME : PAYLOADS.IDENTIFY)}`);
    return this.wsSend(internals.sessionID ? PAYLOADS.RESUME : PAYLOADS.IDENTIFY);
  }
  /**
   * Sets the directMessages of the client
   * @param {array} DMArray - Arrays of DMs to set
   */
  _setDirectMessages(DMArray)
  {
    for(let i = 0; i < DMArray.length; i++)
    {
      this.directMessages[[DMArray[i]].id] = new DMChannel();
    }
  }
}

class Base
{
  constructor(data)
  {
    Object.defineProperty(this, 'merge', {
      value: (obj2) =>
      {
        Object.keys(obj2).forEach((attrib) =>
        {
          if(!Array.isArray(obj2[attrib]))
          {
            this[attrib] = obj2[attrib];
          }
        });
  
        return this;
      },
      enumerable: false
    });
    this.merge(data);
  }
}
class Server extends Base
{
  constructor(data, client)
  {
    super(data);
    data.roles ? this.roles  = new Roles(data.roles): '';
    data.members ? this.members = new Members(data.members, client) : '';
  }
  update(data)
  {
    this.merge(data);
  }
  _processArr(arr, attrib)
  {
    this[attrib] = {};
    let arrLen = arr.length;
    for(let i = 0; i < arrLen; i ++)
    {
      this[attrib][arr[i].id] = arr[i];
    }
  }
}
class Members
{
  constructor(data, client)
  {
    let len = data.length;
    for(let i = 0; i < len; i++)
    {
      this[data[i].user.id] = new Member(data[i]);
      client.users[data[i].user.id] = new User(data[i].user);
    }
  }
  update(memberArray, client)
  {
    let len = memberArray.length;
    for(let i = 0; i < len; i++)
    {
      client.users[data[i].user.id] ?
        client.users[data[i].user.id].update(data[i]) : 
        client.users[data[i].user.id] = new User(data[i]);
      this[data[i].user.id].update(data[i]);
    }
  }
  addMember(data)
  {
    this[data[i].user.id] = new Member(data[i]);
  }
}
class Member
{
  constructor(data)
  {
    this.fillData(data);
  }
  update(data)
  {
    this.fillData(data);
  }
  fillData(data)
  {
    Object.keys(data).forEach((key) =>
    {
      if(key !== 'user' && key !== 'guild_id')
      {
        this[key] = data[key];
      }
      else
      {
        this.id = data.user.id;
      }
    });
  }
}
class Channel extends Base
{
  constructor(data)
  {
    super(data);
  }
}
class DirectMessage extends Channel
{
  constructor(data)
  {
    super(data);
  }
}
class Roles
{
  constructor(data)
  {
    let len = data.length;
    for(let i = 0; i < len; i ++)
    {
      this[data[i].id] = data[i];
    }
  }
}

class User 
{
  constructor(userData)
  {
    Object.assign(this, userData);
    this.bot = this.bot || false;
    this.referenceCount = 1;
  }
}
class Message
{
  constructor(data, client)
  {
    Object.assign(this, data);
    this._client = client;
  }
  edit(content)
  {
    return new Promise((resolve, reject) =>
    {
      let newContent ={
        content: content,
        embed: arguments[1] || {}
      };
      return this._client._APIcall('patch', this._client.ENDPOINTS.MESSAGES(this.channel_id, this.id), newContent).then((result) =>
      {
        resolve(result);
      }).catch((err) =>
      {
        reject(err);
      });
    });
  }
}

module.exports = Client;