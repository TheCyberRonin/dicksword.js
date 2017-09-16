Any of these will work with sendMessage
```js
sendMessage('message body', { embed: { title: 'Sugoi', description: 'memes' } });

sendMessage({ embed: { title: 'Sugoi', description: 'memes' } });

sendMessage({ content: 'message body', embed: { title: 'Sugoi', description: 'memes' } });

sendMessage('message body');

sendMessage({ content: 'message body');
```
