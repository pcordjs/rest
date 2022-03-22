# @pcordjs/rest

@pcordjs/rest is a simple, low-level REST client for the Discord API, that has
first-class TypeScript support.

- Minimal dependencies
- Prevents rate limits (before they happen!)
- Easy to use, `Promise`-based API
- Ships with type definitions
<!-- - Well documented (we'll save this for when docs can actually be accessed) -->

## Installation

@pcordjs/rest can be installed from the npm registry, using the package manager
of your choice. **Node.js 16+ is supported.**

```sh
npm install @pcordjs/rest
# or...
pnpm add @pcordjs/rest
# or...
yarn add @pcordjs/rest
```

You can also download a pre-built tarball of the [latest
release](https://github.com/pcordjs/rest/releases).

## Getting Started

As an example, let's have a bot send a message containing "Hello World!" to a channel.

To begin, you must first create a `RESTClient` object. The `botToken` variable
should be set to the bot's token, retrieved from the Discord Developer Portal.
In addition, set `channelId` to the ID of the channel you would like to send the
message to.

```ts
import RESTClient from '@pcordjs/rest';
// const { default: RESTClient } = require('@pcordjs/rest');

const client = new RESTClient({
  token: botToken, // tells Discord who we are
  apiVersion: 10 // using the v10 api
});
```

Next, use the client's `request` method to create the message:

```ts
await client.request('POST', `/channels/${channelId}/messages`, {
  auth: true, // enables sending our token to Discord
  body: {
    content: "Hello World!"
  }
});
```

Or, if you don't have access to top-level await:

```ts
client.request('POST', `/channels/${channelId}/messages`, {
  auth: true, // enables sending our token to Discord
  body: {
    content: "Hello World!"
  }
}).catch((err) => {
  // handle error
});
```

You can [learn
more](https://discord.com/developers/docs/resources/channel#create-message)
about the `POST /channels/{channel.id}/messages` endpoint on the Discord
Developer Docs.

## Examples

### Sending a message containing an embed

```ts
import RESTClient from '@pcordjs/rest';

const client = new RESTClient({
  token: 'xxx.xxx.xxx',
  apiVersion: 10
});

await client.request('POST', '/channels/123456789012345678/messages', {
  auth: true,
  body: {
    embeds: [
      {
        title: '@pcordjs/rest',
        description: 'REST client for Discord'
      }
    ]
  }
});
```

### Using the discord-api-types package

```ts
import RESTClient from '@pcordjs/rest';
import { Routes } from 'discord-api-types/v10';

const client = new RESTClient({
  token: 'xxx.xxx.xxx',
  apiVersion: 10
});

await client.request('POST', Routes.channelMessages('123456789012345678'), {
  auth: true,
  body: {
    content: 'Hello World!'
  }
});
```

### Including an audit log reason with a request

```ts
import RESTClient from '@pcordjs/rest';

const client = new RESTClient({
  token: 'xxx.xxx.xxx',
  apiVersion: 10
});

await client.request('PATCH', '/channels/123456789012345678', {
  auth: true,
  body: {
    name: 'new-channel-name'
  },
  headers: {
    'X-Audit-Log-Reason': '@pcordjs/rest example'
  }
});
```
