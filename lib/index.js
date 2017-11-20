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
 * @example
 * new Client{token: 'token', cacheOfflineUsers: true, autorun: true}
 */
class Client extends EventEmitter
{
  constructor(settings)
  {
    super();
    if(!settings.token) new Error(`You don't have a token`);
    settings.status ? this._checkStatus(settings.status): this.status = 'online';
    /**
     * Internal information about the bot
     * @type {Object}
     * @prop {String} internals.token
     */
    this.internals = {};
    this.internals.token = settings.token;
    this._messageCacheLimit = settings.messageCacheLimit || 50;
    /**
     * Switch for caching all offline users
     * @type {Boolean}
     */
    this.cacheOfflineUsers = settings.cacheOfflineUsers || false;
    /**
     * Object containing all servers that you are on, with the keys being the server's ID (Snowflake)
     * @type {Object}
     */
    this.servers = {};
    /**
     * Object containing all channels that the bot is a part of, with the keys being channel IDs (Snowflake)
     * @type {Object<Server>}
     */
    this.channels = {};
    /**
     * Object containing all of the users that the bot can see, the keys are the user IDs (Snowflake)
     * @type {Object<User>}
     */
    this.users = {};
    this.directMessages = {};
    this.bot = false;
    this.ping = 0;
    this.internals.sequence = null;
    this.lastPresence = {
      game: settings.game ? 
      {
        name: settings.game.name,
        type: settings.game.type ? settings.game.type : 0, 
        url: settings.game.url || null
      } : {},
      status: this.status,
      afk: false
    };
    this.setPresence = this.setPresence.bind(this);
    this._handleIdentify = this._handleIdentify.bind(this);
    this._setEndpoints();
    if(settings.autorun)
    {
      this.connect();
    }
  }
    /**
   * Sets the endpoints for accessing Discord
   * @private
   */
  _setEndpoints()
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
   * @private
   * @returns {Promise<string>} - Full URL to access the gateway for the websocket connection to Discord
   */
  _getGatewayInfo()
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
   * @private
   * @param {string} gateway - URL for connecting to Discord via websocket
   */
  _connect(gateway)
  {
    this.init();
    this.DiscordWebSocket = new WebSocket(gateway);
    //handle close on close, and error
    this.DiscordWebSocket.once('close', this._handleWSClose.bind(this));
    this.DiscordWebSocket.once('error', this._handleWSClose.bind(this));
    this.DiscordWebSocket.on('message', this._handleWS.bind(this));
  }
  /**
   * Sets the headers for API calls to Discord
   * @private
   * @returns {object}
   */
  _setHeaders()
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
   * Checks to see if the user entered a valid status to be sent
   * @private
   * @returns {String} - If valid, returns the status. If invalid, returns online
   */
  _checkStatus(string)
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
   * Handles the payloads from the websocket connection
   * @private
   * @param {object} data - payload from the websocket connection 
   */
  _handleWS(data)
  {
    let wsPayload = this._processWS(data);
    //debug
    this.emit('debug', `wsPayload in _handleWS ${JSON.stringify(wsPayload)}`);
    let wsData = wsPayload.d;
    wsPayload.op !== 11 ? this.internals.sequence = wsPayload.s : '';

    switch(wsPayload.op)
    {
    case 10:
      this._handleIdentify();
      this.internals.trace = wsData._trace;
      this._keepAlive = setInterval(() =>
      {
        this.internals._lastHB = Date.now();
        this._wsSend(this.PAYLOADS.HEARTBEAT());
      }, wsData.heartbeat_interval);
      break;
    case 11:
      this.ping = (Date.now() - this.internals._lastHB);
      //debug
      this.emit('debug', `IN HB: ~~~~ ${Date.now() - this.internals._lastHB}`);
      break;
    case 9:
      !wsData ? this.internals.sessionID = null : '';
      this._handleWSClose(1006);
      break;
    case 7:
      this._handleWSClose(1006);
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
      this._handleOauth();
      this._handleGuilds(wsData.guilds);
      this.emit('ready');
      break;
    case 'MESSAGE_CREATE':
      this.emit('message', new Message(wsData, this));
      break;
    case 'CHANNEL_CREATE':
      wsData.guild_id ? 
      this.servers[wsData.guild_id].channels[wsData.id] = new Channel(wsData) :
      this.directMessages[wsData.id] = new Channel(wsData);
      this.channels[wsData.id] = new Channel(wsData);
      this.emit('channelCreate', new Channel(wsData));
      break;
    case 'CHANNEL_UPDATE':
      wsData.guild_id ? 
      this.servers[wsData.guild_id].channels[wsData.id] = new Channel(wsData) :
      this.directMessages[wsData.id] = new Channel(wsData);
      this.channels[wsData.id] = new Channel(wsData);
      this.emit('channelUpdate', new Channel(wsData));
      break;
    case 'CHANNEL_DELETE':
      delete this.servers[wsData.guild_id].channels[wsData.id];
      delete this.channels[wsData.id];
      this.emit('channelDelete', new Channel(wsData));
      break;
    case 'GUILD_CREATE':
      this.servers[wsData.id] = new Server(wsData, this);
      this.cacheOfflineUsers ? this._checkOfflineMembers(wsData.id) : '';
      this.emit('guildCreate', this.servers[wsData.id]);
      break;
    case 'GUILD_DELETE':
      if(wsData.unavailable)
      {
        this.servers[wsData.id] = new Server(wsData, this);
        this.emit('guildUnavailable', new Server(wsData, this));
      }
      else
      {
        let deleted = this.servers[wsData.id];
        this._handleGuildRemove(deleted.members);
        delete this.servers[wsData.id];
        this.emit('guildDelete', deleted);
      } 
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
      if(this.servers[wsData.guild_id])
      {
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
      }
      else
      {
        console.log(`Server ID: ${wsData.guild_id}, user ID: ${wsData.user.id}`);
      }
      this.emit('guildMemberRemove', wsData);
      break;
    case 'GUILD_MEMBER_UPDATE':
      this.servers[wsData.guild_id].members[wsData.user.id].update(wsData, this);
      this.emit('guildMemberUpdate', wsData);
      break;
    case 'GUILD_MEMBERS_CHUNK':
      this._handleGuildChunk(wsData);
      break;
    }
  }
  _handleGuildRemove(members)
  {
    Object.keys(members).forEach((key) =>
    {
      if(this.users[key])
      {
        this.users[key].referenceCount --;
        if(this.users[key].referenceCount === 0)
        {
          delete(this.users[key]);
        }
      }
    });
  }
  /**
   * Handles the chunk of users and will cache them appropriately in the guild and cached users
   * @private
   * @param {Object} chunk - Guild chunk from Discord docs 
   */
  _handleGuildChunk(chunk)
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
        users[userID] ? users[userID].referenceCount++ : users[userID] = new User(chunk.members[i].user);
        server.members[userID] = new Member(chunk.members[i]);
      }
    }
  }
  /**
   * Gets the Oauth information associated with the bot
   * @private
   */
  _handleOauth()
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
   * Internal helper for checking offline users, will check to see if you need ot check for offline members
   * @private
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
   * @private
   * @param {String} serverID 
   */
  _getOfflineMembers(serverID)
  {
    this._wsSend(this.PAYLOADS.REQUEST_OFFLINE_MEMBERS(serverID));
  }
  /**
   * Handles the guilds from the READY payload
   * @private
   * @param {array} guildArr 
   */
  _handleGuilds(guildArr)
  {
    let arrLen = guildArr.length;
    for(let i = 0; i < arrLen; i++)
    {
      this.servers[guildArr[i].id] = new Server(guildArr[i]);
    }
  }
    /**
   * Handles the closing of the websocket connection
   * @private
   * @param {number} code - Error code 
   * @param {object} data - Data provided
   */
  _handleWSClose(code, data)
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
      this.emit('debug', `${code} in err check for _handleWSClose`);
      return this.reconnect();
    }
    else if(code === 1000)
    {
      this.emit('debug', `${code} in err check for _handleWSClose`);
      this.internals.sessionID = null;
      return this.reconnect();
    }

    this.emit('disconnect', errMessage, code);
  }
  /**
   * Handles any API call to Discord
   * @private
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
      callOptions.headers = this._setHeaders();
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
   * @private
   * @param {object} message - Payload from a websocket message
   */
  _processWS(message)
  {
    return message instanceof Buffer ? JSON.parse(Zlib.inflateSync(message).toString()) : JSON.parse(message);
  }
  /**
   * Sends data through the websocket
   * @private
   * @param {object} data - Data to send 
   */
  _wsSend(data)
  {
    this.emit('debug', `DATA IN SEND ${JSON.stringify(data)}`);
    if(this.DiscordWebSocket && this.DiscordWebSocket.readyState === 1)
    {
      this.DiscordWebSocket.send(JSON.stringify(data));
    }
  }
  /**
   * Decides whether or not to resume or identify to Discord
   * @private
   */
  _handleIdentify()
  {
    let PAYLOADS = this.PAYLOADS;
    let internals = this.internals;
  
    this.emit('debug', `In _handleIdentify ${JSON.stringify(internals.sessionID ? PAYLOADS.RESUME : PAYLOADS.IDENTIFY)}`);
    return this._wsSend(internals.sessionID ? PAYLOADS.RESUME : PAYLOADS.IDENTIFY);
  }
  /**
   * Sets the directMessages of the client
   * @private
   * @param {array} DMArray - Arrays of DMs to set
   */
  _setDirectMessages(DMArray)
  {
    for(let i = 0; i < DMArray.length; i++)
    {
      this.directMessages[[DMArray[i]].id] = new Channel();
    }
  }
  /**
   * Handles connecting to Discord via websocket
   */
  connect()
  {
    this._getGatewayInfo().then((gateway) =>
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
        this._handleWSClose(1006);
      }
    },8000);

  }
  /**
   * Sets the presence of the bot
   */
  setPresence(presence)
  {
    let currentPresence = this.lastPresence;
    let _wsSend = this._wsSend.bind(this);
    let PAYLOADS = this.PAYLOADS;
    return new Promise((resolve, reject) =>
    {
      currentPresence.game = {
        name: presence.game.name ? presence.game.name : reject('The object needs a name member.'),
        type: presence.game.type ? presence.game.type : 0,
        url: presence.game.url || null
      };
      currentPresence.status = presence.status !== undefined ? this._checkStatus(presence.status) : 'online';
      _wsSend(PAYLOADS.STATUS(currentPresence));
      resolve(true);
    });

  }
  /**
   * Initializes some internals and creates the payloads to send to Discord
   * @private
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
      else if(message === undefined)
      {
        reject('Cannot send message: No message or embed in sendMessage.');
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
      }).catch(reject);
    }); 
  }
  editInfo(info)
  {
    return new Promise((resolve, reject) =>
    {
      let infoObj = {
        avatar: info.avatar ? `data:image/jpg;base64,${info.avatar}` : this.avatar,
        username: info.username ? info.username : this.username
      };
      this._APIcall('patch', this.ENDPOINTS.ME, infoObj).then((result) =>
      {
        let updatedUser = result.body;
        this.username === updatedUser.username ? '' : this.username = updatedUser.username;
        this.discriminator === updatedUser.discriminator ? '' : this.discriminator = updatedUser.discriminator;
        this.avatar === updatedUser.avatar ? '' : this.avatar = updatedUser.avatar;
      }).catch(reject);
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
}
/**
 * Base class for container classes
 * @param {Object} data Raw data from the websocket
 */
class Base
{
  constructor(data)
  {
    /**
     * @private
     * @function merge
     * @memberof Base
     * @param {Object} obj2 Another object to copy into this one
     */
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
/**
 * Server class containing pertinent information about a server
 * @param {Object} data Raw server data from the websocket
 * @param {Client} client Client obj
 */
class Server extends Base
{
  constructor(data, client)
  {
    super(data);
    data.roles ? this.roles  = new Roles(data.roles): '';
    data.members ? this.members = new Members(data.members, client) : '';
    data.channels ? this.channels = new Channels(data.channels, client, this.id) : '';
  }
  /**
   * Updates a Server based on information receieved from the websocket
   * @param {Object} data Raw server data from the websocket
   */
  update(data)
  {
    this.merge(data);
  }
  /**
   * Testing function for processing Array stuffs
   * @private
   * @param {Array} arr 
   * @param {String} attrib 
   */
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
/**
 * Container for Member objects
 * @param {Array} data Raw data from the websocket (Array of Discord Member objects)
 * @param {Client} client Client object
 */
class Members
{
  constructor(data, client)
  {
    let len = data.length;
    for(let i = 0; i < len; i++)
    {
      this[data[i].user.id] = new Member(data[i]);
      client.users[data[i].user.id] ? client.users[data[i].user.id].referenceCount++ : client.users[data[i].user.id] = new User(data[i].user);
    }
  }
  /**
   * 
   * @param {Array} memberArray Array of members belonging to a certain server 
   * @param {Client} client Client object
   */
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
/**
 * Contains information pertaining to a member of a server
 * @param {Object} data Raw member data from the websocket
 */
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
    });
    this.id = data.user.id;
    this.username = data.user.username;
    this.discriminator = data.user.discriminator;
  }
}
/**
 * Contains information pertaining to a channel
 * @param {Object} data Raw channel data from the websocket
 */
class Channel extends Base
{
  constructor(data, guild_id)
  {
    super(data);
    data.permission_overwrites ? this.permission_overwrites = data.permission_overwrites: '';
    data.recipients ? this.recipients = data.recipients : '';
    guild_id ? this.guild_id = guild_id : '';
  }
}
class Channels
{
  constructor(data, client, guild_id)
  {
    let len = data.length;
    for(let i = 0; i < len; i ++)
    {
      this[data[i].id] = new Channel(data[i], guild_id);
      client.channels[data[i].id] = new Channel(data[i], guild_id);
    }
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
/**
 * Contains everything pertaining to a User
 * @param {Object} userData Raw user data from the websocket
 */
class User 
{
  constructor(userData)
  {
    Object.assign(this, userData);
    this.bot = this.bot || false;
    /**
     * Counts how many servers the User shares with the bot, used mostly for checking when to uncache the User
     * @type {Number}
     */
    this.referenceCount = 1;
  }
}
/**
 * Contains everything pertaining to a message
 * @param {Object} data Raw message data from the websocket
 * @param {Client} client Client object
 */
class Message
{
  constructor(data, client)
  {
    Object.assign(this, data);
    this._client = client;
  }
  /**
   * Edits a message to have the desired content
   * @param {Object} content New content to edit the message with
   * @returns {Promise<Object>}
   */
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
      }).catch(reject);
    });
  }
}

module.exports = Client;
