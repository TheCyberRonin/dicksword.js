declare module dicksword.js {
  declare type settings = {
    token: string,
    game?: game,
    status?: string,
    autorun?: boolean,
    cacheOfflineUsers?: boolean
  }
  
  declare type game = {
    name: string,
    type: number,
    url?: string
  }
  
  export class Client {
    constructor(settings: settings);
  }  
}


