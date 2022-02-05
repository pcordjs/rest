import * as https from 'https';
import * as stream from 'stream';
import { URLSearchParams } from 'url';
import { createGunzip, createInflate } from 'zlib';
import RESTError, { RESTErrorCode } from './RESTError';

// eslint-disable-next-line
const packageInfo = require('../package.json') as { version: string };

const BASE_USER_AGENT = `DiscordBot (https://github.com/pcordjs/rest, ${packageInfo.version})`;

export enum RequestDestination {
  API,
  CDN
}

export enum TokenType {
  BOT,
  BEARER
}

const httpsAgent = new https.Agent({ keepAlive: true });

export default class RESTClient {
  public constructor(private readonly options: RESTClientOptions) {}

  public get userAgent(): string {
    const parts = [BASE_USER_AGENT];

    if (this.options.userAgentSuffix) {
      parts.push(this.options.userAgentSuffix);
    }

    return parts.join(', ');
  }

  public get auth(): string {
    if (!this.options.token) throw new RESTError(RESTErrorCode.TOKEN_REQUIRED);
    return `${this.options.tokenType === TokenType.BEARER ? 'Bearer' : 'Bot'} ${
      this.options.token
    }`;
  }

  public request<ResponseType = Buffer>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ) {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Accept-Encoding': 'gzip,deflate',
      ...options.headers
    };

    if (options.auth) headers.Authorization = this.auth;

    let finalPath = path;
    if (options.queryString) finalPath += `?${options.queryString.toString()}`;

    return this.finalizeRequest({
      headers,
      method,
      path: finalPath,
      host:
        options.destination === RequestDestination.CDN
          ? this.options.cdn ?? 'cdn.discordapp.com'
          : this.options.api ?? 'discord.com',
      agent: this.options.agent ?? httpsAgent,
      body: options.body === undefined ? undefined : Buffer.from(options.body),
      timeout: options.timeout ?? this.options.timeout ?? Infinity
    }) as Promise<ResponseType>;
  }

  /** Sends a request, ignoring any ratelimits. */
  private finalizeRequest(init: {
    headers: Record<string, string>;
    method: string;
    path: string;
    host: string;
    agent: https.Agent;
    body?: Buffer;
    timeout: number;
  }) {
    return new Promise((resolve, reject) => {
      let cancelled = false;
      const timeout =
        init.timeout === Infinity
          ? null
          : setTimeout(() => {
              cancelled = true;
              reject(
                new RESTError(RESTErrorCode.TIMEOUT, init.path, init.timeout)
              );
            }, init.timeout).unref();

      const request = https.request({
        agent: init.agent,
        host: init.host,
        path: init.path,
        headers: init.headers,
        method: init.method
      });

      request.once('error', (err) => {
        request.destroy();
        reject(
          Object.assign(err, {
            request
          })
        );
      });

      request.once('response', (response) => {
        const handleError = (err: Error) => {
          request.emit(
            'error',
            Object.assign(err, {
              response
            })
          );
        };

        response.once('error', handleError);

        let stream: stream.Readable = response;
        if (response.headers['content-encoding']) {
          const encoding = response.headers['content-encoding'];

          // TODO: remove me
          console.log(response.headers);

          if (encoding.includes('gzip')) {
            stream = response.pipe(createGunzip());
          } else if (encoding.includes('deflate')) {
            stream = response.pipe(createInflate());
          }
        }

        stream.once('error', handleError);

        let data = '';
        stream
          .on('data', (chunk) => {
            data += chunk;
          })
          .once('end', () => {
            if (cancelled) return;
            if (timeout !== null) clearTimeout(timeout);

            if (
              response.headers['content-type']?.startsWith('application/json')
            ) {
              resolve(JSON.parse(data));
            } else {
              resolve(Buffer.from(data));
            }
          });
      });

      request.end(init.body);
    });
  }

  private static getRateLimitBucket(this: void, path: string) {
    return (
      /^\/api\/v\d+\/(channels\/\d+|guilds\/\d+|webhooks\/\d+\/\d+)/.exec(
        path
      )?.[1] ?? null
    );
  }
}

export interface RequestOptions {
  /** The headers to send with the request */
  headers?: Record<string, string>;
  /** The body of the request */
  body?: string | Buffer;
  /** Whether or not to attach the `Authorization` header (requires token) */
  auth?: boolean;
  /** The amount of time, in milliseconds, after which to give up the request */
  timeout?: number;
  /** Where the request will be sent to - the API, or CDN */
  destination?: RequestDestination;
  /** Query string pieces to be appended to the path */
  queryString?: URLSearchParams;
}

export interface RESTClientOptions {
  /** The token used to authenticate with the Discord API */
  token?: string;
  /** Specifies whether this is a bot token or a bearer token. */
  tokenType?: TokenType;
  /** The endpoint of the Discord API */
  api?: string;
  /** The endpoint of the Discord CDN */
  cdn?: string;
  /** Information to be appended to the base [User Agent](https://discord.com/developers/docs/reference#user-agent) */
  userAgentSuffix?: string;
  /** Passed to `https.request` */
  agent?: https.Agent;
  /** The default value of {@link RequestOptions.timeout} */
  timeout?: number;
}
