Any of these will work with sendMessage
```js
sendMessage(channelID, 'message body', { embed: { title: 'Sugoi', description: 'memes' } });

sendMessage(channelID, { embed: { title: 'Sugoi', description: 'memes' } });

sendMessage(channelID, { content: 'message body', embed: { title: 'Sugoi', description: 'memes' } });

sendMessage(channelID, 'message body');

sendMessage(channelID, { content: 'message body');
```
