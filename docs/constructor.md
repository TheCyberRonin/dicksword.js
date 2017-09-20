```js
const Client = require('dicksword.js');

const bot = new Client({
  token: 'token',
  autorun: true,
  game: {name: 'dicksword.js wew'}
});
```
The base constructor needs a token, autorun and game are optional.  
The game(presence) can be set by any of these ways below.

```js
game: {name: 'whatevs'}
game: {name: 'whatevs', url: 'valid twitch url'}
game: {name: 'whatevs', type: 0}
game: {name: 'whatevs', type: 1, url: 'valid twitch url'}
```