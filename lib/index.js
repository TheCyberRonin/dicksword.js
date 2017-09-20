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
 * @param {Number} [settings.messageCacheLimit] - Amount of messages to cache
 */
class Client extends EventEmitter
{
  constructor(settings)
  {
    super();
    if(!settings.token) process.exit(1);
    this.status = settings.status === undefined ? null : settings.status;
    this.internals = {};
    this.internals.token = settings.token;
    this._messageCacheLimit = settings.messageCacheLimit || 50;
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
      status: 'online',
      afk: false
    };
    this.setPresence = this.setPresence.bind(this);
    this.handleIdentify = this.handleIdentify.bind(this);
    this.setEndpoints();
    if(settings.autorun)
    {
      this.connect();
    }
  }
  /**
   * Handles connecting to Discord via websocket
   */
  connect()
  {
    this.getGatewayInfo().then((gateway) =>
    {
      console.log(gateway);
      this.internals.gateway = gateway;
      this._connect(gateway);
    }).catch((err) =>
    {
      return this.emit('disconnect', 'Error getting gateway: ' + err, 0);
    });
  }
  /**
   * Handles reconnecting to the websocket (this is what should be called in the client if you want to reconnect)
   */
  reconnect()
  {
    if(!this.DiscordWebSocket)
    {
      setTimeout(() => {this.connect();}, 8000);
    }
    else
    {
      this.handleWSClose(1000);
    }
  }
  /**
   * Sets the presence of the bot
   */
  setPresence(game)
  {
    let presence = this.lastPresence;
    let wsSend = this.wsSend.bind(this);
    let PAYLOADS = this.PAYLOADS;
    return new Promise((resolve, reject) =>
    {
      presence.game = {
        name: game.name ? game.name : reject('The object needs a name member.'),
        type: game.type ? (game.url ? 1 : 0) : 0,
        url: game.url || null
      };
      wsSend(PAYLOADS.STATUS(presence));
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
      this.APIcall('get', this.ENDPOINTS.GATEWAY).then((response) =>
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
      OFFLINE_USERS: (arr) =>
      {
        return {
          op: 8,
          d: {
            guild_id: array.splice(0,50),
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
    console.log(`wsPayload in handleWS ${JSON.stringify(wsPayload)}`);
    let _data = wsPayload.d;
    let user, server, member, old, userID, serverID, channelID;
    this.internals.sequence = wsPayload.s;

    switch(wsPayload.op)
    {
    case 10:
      this.handleIdentify();
      this._keepAlive = setInterval(() =>
      {
        this.internals._lastHB = Date.now();
        this.wsSend(this.PAYLOADS.HEARTBEAT());
      }, _data.heartbeat_interval);
      break;
    case 11:
      this.ping = (Date.now() - this.internals._lastHB);
      //debug
      console.log(`IN HB: ~~~~ ${Date.now() - this.internals._lastHB}`);
      break;
    }

    this.emit('any', wsPayload);
    switch(wsPayload.t)
    {
    case 'READY':
      //debug
      console.log(`READY YEEEE ${JSON.stringify(wsPayload.t)}`);
      this.internals.sessionID = _data.session_id;
      Object.assign(this, _data.user);
      this.handleGuilds(_data.guilds);
      this.handleDMs(_data.private_channels);
      this.emit('ready');
      break;
    case 'MESSAGE_CREATE':
      this.emit('message', new Message(_data, this));
      break;
    case 'GUILD_CREATE':
      this.servers[_data.id] = new Server(_data);
      this.emit('guildCreate', new Server(_data));
    }
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
      console.log(messageObj);
      this.APIcall('post', this.ENDPOINTS.MESSAGES(channelID), messageObj).then((result) =>
      {
        resolve(new Message(result.body, this));
      }).catch((err) =>
      {
        reject(err);
      });
    }); 
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
    console.log(`Data in wsClose ${data}`);
    //kill main keepalive loop
    clearInterval(this._keepAlive);
    if(this.DiscordWebSocket)
    {
      this.DiscordWebSocket.removeAllListeners('message');
    }
      
    if(code === (1006 || 1001))
    {
      console.log(code);
      return this.reconnect();
    }
    this.DiscordWebSocket = null;
    this.emit('disconnect', errMessage, code);
  }
  /**
   * Handles any API call to Discord
   * @param {string} method - Method to use 
   * @param {string} url - URL for the API to use
   * @returns {Promise<object>} - Response from the API call
   */
  APIcall(method, url)
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
      console.log('~~~~sending~~~~');
      console.log(callOptions);
      got(url, callOptions).then((result) =>
      {
        console.log('~~~~sent~~~~');
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
    console.log(message instanceof Buffer ? 'binary and should inflate' : 'No binary');
    return message instanceof Buffer ? JSON.parse(Zlib.inflateSync(message).toString()) : JSON.parse(message);
  }
  /**
   * Sends data through the websocket
   * @param {object} data - Data to send 
   */
  wsSend(data)
  {
    console.log(`DATA IN SEND ${JSON.stringify(data)}`);
    if(this.DiscordWebSocket && this.DiscordWebSocket.readyState === 1)
    {
      this.DiscordWebSocket.send(JSON.stringify(data));
    }
  }
  /**
   * Decides whether or not to resume or identify to Discord
   */
  handleIdentify()
  {
    let PAYLOADS = this.PAYLOADS;
    let internals = this.internals;
  
    
    console.log(`In handleIdentify ${JSON.stringify(internals.sessionID ? PAYLOADS.RESUME : PAYLOADS.IDENTIFY)}`);
    return this.wsSend(internals.sessionID ? PAYLOADS.RESUME : PAYLOADS.IDENTIFY);
  }
  /**
   * Sets the directMessages of the client
   * @param {array} DMArray - Arrays of DMs to set
   */
  setDirectMessages(DMArray)
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
          console.log(typeof(obj2[attrib]));
          if(!Array.isArray(obj2[attrib]))
          {
            this[attrib] = obj2[attrib];
          }
          else
          {
            this[attrib] = {};
            console.log(obj2[attrib]);
            let arrLen = obj2[attrib].length;
            for(let i = 0; i < arrLen; i ++)
            {
              this[attrib][obj2[attrib][i].id] = obj2[attrib][i];
            }
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
  constructor(data)
  {
    super(data);
  }
  update(data)
  {
    Object.assign(this, data);
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
class Role
{
  constructor()
  {

  }
}
class User 
{
  constructor(userData)
  {
    Object.assign(this, userData);
    //this.bot = this.bot || false;
  }
}
class Message
{
  constructor(data, client)
  {
    Object.assign(this, data);
    this.client = client;
  }
  edit(content)
  {
    return new Promise((resolve, reject) =>
    {
      let newContent ={
        content: content,
        embed: arguments[1] || {}
      };
      return this.client.APIcall('patch', this.client.ENDPOINTS.MESSAGES(this.channel_id, this.id), newContent).then((result) =>
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