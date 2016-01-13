# WebSockets for Node.js
[![npm version](https://img.shields.io/npm/v/websocket13.svg)](https://www.npmjs.com/package/websocket13)
[![npm downloads](https://img.shields.io/npm/dm/websocket13.svg)](https://npmjs.com/package/websocket13)
[![dependencies](https://img.shields.io/david/DoctorMcKay/node-websocket13.svg)](https://david-dm.org/DoctorMcKay/node-websocket13)
[![license](https://img.shields.io/npm/l/websocket13.svg)](https://github.com/DoctorMcKay/node-websocket13/blob/master/LICENSE)
[![paypal](https://img.shields.io/badge/paypal-donate-yellow.svg)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=N36YVAT42CZ4G&item_name=node%2dwebsocket13&currency_code=USD)

This is a pure-JavaScript implementation of [WebSockets version 13](https://tools.ietf.org/html/rfc6455).
It has only one lightweight dependency. Presently it can only establish connections to WebSocket servers (as a client),
but server support is [planned](#planned-features).

**Requires node.js v4.0.0 or later.**

# Installation and Example

Install it from npm:

    $ npm install websocket13

Exports a `WS13` namespace, which contains a few object-enums and the `WebSocket` object.

```js
var WS13 = require('websocket13');

var socket = new WebSocket('wss://echo.websocket.org', {
    "pingInterval": 10000, // default
    "pingTimeout": 10000,  // default
    "pingFailures": 3      // default
    "headers": {
        "Origin": "http://example.com"
    },
    "protocols": ["some_subprotocol", "some_other_subprotocol"],
    "connection": {
        "auth": "aladdin:opensesame",       // HTTP Basic authorization
        "rejectUnauthorized": false         // to not reject self-signed or otherwise invalid certificates
    }
});

socket.on('connected', function(info) {
    console.log("Successfully connected to echo server with HTTP version %s, HTTP status code %d, and HTTP status text %s. Headers follow.",
        info.httpVersion, info.responseCode, info.responseText);
    console.log(info.headers);

    socket.send("This is a string message.");

    var buffer = new Buffer(8);
    buffer.writeUInt32BE(1337, 0);
    buffer.writeUInt32BE(8675309, 4);
    socket.send(buffer);

    setTimeout(() => {
        socket.disconnect(WS13.StatusCode.NormalClosure, "Bye bye!");
    }, 5000);
});

socket.on('message', function(type, data) {
    switch (type) {
        case WS13.FrameType.Data.Text:
            console.log("Received text: %s", data);
            break;

        case WS13.FrameType.Data.Binary:
            console.log("Received binary data containing two integers: %d and %d.",
                data.readUInt32BE(0), data.readUInt32BE(4));
            break;
    }
});

socket.on('disconnected', function(code, reason, initiatedByUs) {
	console.log("Disconnected from echo server with code %d and reason string '%s'. Disconnection %s initiated by us.",
	    code, reason, initiatedByUs ? "was" : "was NOT");
});

socket.on('error', function(err) {
    console.log("Fatal error: %s", err.message);
});
```

# Features

- Very lightweight. Only one dependency (directly; two dependencies counting nested dependencies).
- No native dependencies
- Easy-to-use API
- Supports the latest version of the WebSocket protocol
- TLS support
- Supports WebSocket subprotocols
- Able to automatically send ping requests to the server at a customizable interval, and tear down the connection when the server stops responding
- Supports both UTF-8 and binary data
- Transparent framing removes the need to buffer the TCP connection yourself
- `Stream` interface to which data can be written or piped, and appear on the other side as a single message

# Enums

There are a few enums (implemented as objects) available from the root namespace object that is returned by `websocket13`.
These are:

```js
WS13.State = {
	"Closed": 0,
	"Connecting": 1,
	"Connected": 2,
	"Closing": 3,
	"ClosingError": 4
};

WS13.FrameType = {
	"Continuation": 0x0,

	"Data": {
		"Text": 0x1,
		"Binary": 0x2
	},

	"Control": {
		"Close": 0x8,
		"Ping": 0x9,
		"Pong": 0xA
	}
};

WS13.StatusCode = {
	"NormalClosure": 1000,         /** Graceful disconnection */
	"EndpointGoingAway": 1001,     /** Closing connection because either the server or the client is going down (e.g. browser navigating away) */
	"ProtocolError": 1002,         /** Either side is terminating the connection due to a protocol error */
	"UnacceptableDataType": 1003,  /** Terminating because either side received data that it can't accept or process */
	"Reserved1": 1004,             /** Reserved. Do not use. */
	"NoStatusCode": 1005,          /** MUST NOT be sent over the wire. Used internally when no status code was sent. */
	"AbnormalTermination": 1006,   /** MUST NOT be sent over the wire. Used internally when the connection is closed without sending/receiving a Close frame. */
	"InconsistentData": 1007,      /** Terminating because either side received data that wasn't consistent with the expected type */
	"PolicyViolation": 1008,       /** Generic. Terminating because either side received a message that violated its policy */
	"MessageTooBig": 1009,         /** Terminating because either side received a message that is too big to process */
	"MissingExtension": 1010,      /** Client is terminating because the server didn't negotiate one or more extensions that we require */
	"UnexpectedCondition": 1011,   /** Server is terminating because it encountered an unexpected condition that prevented it from fulfilling the request */
	"TLSFailed": 1015              /** MUST NOT be sent over the wire. Used internally when TLS handshake fails. */
};
```

# Constructor

To construct a new WebSocket client, use this signature:

    WebSocket(uri[, options])

`uri` should be a string containing the URI to which you want to connect. The protocol must be either `ws://` for
insecure, or `wss://` for secure. For example: `wss://echo.websocket.org:443/?query=string`.

`options` should be an object containing zero or more of the properties in the following section. You can omit it if
you don't wish to pass any options.

The WebSocket will immediately attempt to connect after being constructed. If you want to reconnect after being
disconnected, you should construct a new one.

# Options

### pingInterval

Defaults to `10000`. The time in milliseconds between `Ping` requests that we send to the server automatically.

### pingTimeout

Defaults to `10000`. The time in milliseconds that we will wait for a `Pong` in reply to a `Ping` request (controlled
by the `pingInterval` option).

### pingFailures

Defaults to `3`. After this many `Ping` requests timeout, the WebSocket will be closed and `error` will be emitted
with `message` equaling `Ping timeout`.

### headers

An object containing any HTTP headers which will be added to the connection handshake. The following headers are
reserved for internal use and will be ignored:

- Host
- Upgrade
- Connection
- Sec-WebSocket-Version
- Sec-WebSocket-Protocol
- Sec-WebSocket-Extensions
- Sec-WebSocket-Key

### protocols

An array of strings containing acceptable subprotocols. These will be sent to the server in the connection handshake
and if any are acceptable, the server will choose one. The chosen subprotocol will be assigned to the `protocol`
property in the [`connected`](#connected) event.

### connection

An object containing select properties from `http.request` (or `https.request`):

- `localAddress` - The local IP address to connect from
- `auth` - `username:password` string to use for HTTP Basic authorization

**The following only apply to secure connections:**

- `pfx` - Certificate, Private key and CA certificates to use for SSL. Default `null`.
- `key` - Private key to use for SSL. Default `null`.
- `passphrase` - A string of passphrase for the private key or pfx. Default `null`.
- `cert` - Public x509 certificate to use. Default `null`.
- `ca` - A string, `Buffer` or array of strings or `Buffer`s of trusted certificates in PEM format. If this is omitted several well known "root" CAs will be used, like VeriSign. These are used to authorize connections.
- `ciphers` - A string describing the ciphers to use or exclude. Consult [OpenSSL's docs](https://www.openssl.org/docs/apps/ciphers.html#CIPHER_LIST_FORMAT) for details on the format.
- `rejectUnauthorized` - If `true`, the server certificate is verified against the list of supplied CAs. An `error` event is emitted if verification fails. Verification happens at the connection level, before the handshake request is sent. Default `true`.
- `secureProtocol` - The SSL method to use, e.g. SSLv3_method to force SSL version 3. The possible values depend on your installation of OpenSSL and are defined in the constant [`SSL_METHODS`](https://www.openssl.org/docs/ssl/ssl.html#DEALING_WITH_PROTOCOL_METHODS).

# Properties

### options

**Read-only.** The options object which you provided to the constructor.

### hostname

The hostname or IP address of the server to which we're connected.

### port

The port to which we're connected on the server.

### path

The request path of the handshake.

### headers

An object containing the HTTP headers we sent in the handshake.

### state

A value from the `WS13.State` enum representing our current connection state.

### extensions

An array containing the WebSocket extensions which are currently in use. Currently, none are supported so this will be
empty.

### protocol

The subprotocol chosen by the server, if any. `null` if none.

# Methods

### disconnect([code][, reason])
- `code` - A value from the `WS13.StatusCode` enum describing why we're disconnecting. Defaults to `NormalClosure`.
- `reason` - An optional string explaining why we're disconnecting. Does not need to be human-readable. Defaults to empty.

Begins our side of the disconnection process. [`disconnected`](#disconnected) will be emitted when fully disconnected.
You cannot send any more data after calling `disconnect()`.

### send(data)
- `data` - Either a `string` or `Buffer` containing the data you want to send

Sends either UTF-8 string or binary data to the server. If `data` is a `string`, it must be valid UTF-8. Otherwise, it
must be a `Buffer` containing the binary data you wish to send. Since the WebSocket protocol has transparent framing,
unlike plain TCP, the data will be received in one whole message. Therefore, one `send()` call maps to exactly one
received message on the other side.

The message will be queued and sent after every message before it is sent. If you have an ongoing
[`StreamedOutgoingFrame`](#streamedoutgoingframe), it will be delayed until after the entire stream is sent.

### createMessageStream(type)
- `type` - A value from the `WS13.FrameType.Data` enum representing what kind of data is to be sent

Creates and returns a new [`StreamedOutgoingFrame`](#streamedoutgoingframe) object. See the [`StreamedOutgoingFrame` documentation](#streamedoutgoingframe)
for more information.

# Events

### connected
- `details` - An object containing details about your connection
    - `httpVersion` - The HTTP version used by the server
    - `responseCode` - The HTTP response code sent by the server (always `101`)
    - `responseText` - The HTTP response text sent by the server (usually `Switching Protocols`)
    - `headers` - An object containing the HTTP headers received from the server

Emitted when we successfully establish a WebSocket connection to the server. At this point, the [`state`](#state)
property will equal `WS13.State.Connected`, the [`extensions`](#extensions) array will be populated with any extensions
that are in use, and the [`protocol`](#protocol) property will be defined with the subprotocol selected by the server,
if any. You can now safely send and receive data.

### disconnected
- `code` - A value from the `WS13.StatusCode` enum
- `reason` - A string (possibly empty) which may or may not be human-readable describing why you disconnceted
- `initiatedByUs` - `true` if we initiated this disconnection, or `false` if the server condition did

Emitted when we're disconnected from the server. Not emitted if we're disconnected due to an error; see [`error`](#error)
in that case.

### error
- `err` - An `Error` object

Emitted when a fatal error causes our connection to fail (while connecting) or be disconnected (while connected). Under
certain conditions, `err` may contain zero or more of these properties:

- `responseCode` - The HTTP status code we received if the error occurred during the handshake
- `responseText` - The HTTP status text we received if the error occurred during the handshake
- `httpVersion` - The HTTP version employed by the server if the error occurred during the handshake
- `headers` - An object containing the HTTP headers we received from the server if the error occurred during the handshake
- `expected` - A string containing the `Sec-WebSocket-Accept` value we expected to receive, if the error occurred because we didn't
- `actual` - A string containing the actual `Sec-WebSocket-Accept` value we received, if the error occurred because it didn't match what we expected
- `state` - The connection state at the time of error. Always present.
- `code` - A value from the `WS13.StatusCode` enum, if the error occurred after the WebSocket connection was established

### message
- `type` - A value from the `WS13.FrameType.Data` enum describing what type of data we received
- `data` - The data we received

Emitted when we receive a complete message from the server. If `type` is `Text`, then `data` is a UTF-8 string.
If `type` is `Binary`, then `data` is a `Buffer`.

### streamedMessage
- `type` - A value from the `WS13.FrameType.Data` enum descrbing what type of data we're receiving
- `stream` - A [`StreamedIncomingFrame`](#streamedincomingframe) object

Emitted when we receive the first part of a fragmented frame. See the [`StreamedIncomingFrame`](#streamedincomingframe)
section for more information about this. If this event isn't handled, then fragmented incoming frames will be buffered
internally, and [`message`](#message) will be emitted when the entire message is received, as normal.

# StreamedOutgoingFrame

Messages are sent over WebSockets in *frames*. Usually, a frame contains one complete message. However, the WebSocket
protocol also allows messages to be split up across multiple frames. This is useful when the entire data isn't available
at the time of sending, and you'd like to stream it to the other side. In this case, call
[`createMessageStream`](#createmessagestreamtype), which returns a `StreamedOutgoingFrame` object.

`StreamedOutgoingFrame` implements the [`Writable`](https://nodejs.org/api/stream.html#stream_class_stream_writable) interface.
To send a chunk of data to the server, just call `frame.write(chunk)`. When you're done, call `frame.end()`.

Because this implements the `Writable` interface, you can `pipe()` a `ReadableStream` into it. One use-case would be to
pipe a download or a file on the disk into a WebSocket.

One frame can contain only one type of data. This data type is set in the `createMessageStream` method, and is fixed
for the lifetime of the `StreamedOutgoingFrame`. Therefore, if your data type is `Text`, you must only call `write()` with
UTF-8 strings. If it's `Binary`, you must only call `write()` with `Buffer` objects. If you call `write()` with the
wrong data type, the `StreamedOutgoingFrame` will emit an `error`.

You *can* call `send()` or create new `StreamedOutgoingFrame`s while you have one ongoing, but they will be queued and cannot
be sent to the server until the currently-active `StreamedOutgoingFrame` is ended. Be sure to call `end()` when you're done
writing data to it.

# StreamedIncomingFrame

Similar to [`StreamedOutgoingFrame`](#streamedoutgoingframe), this object is a
[`Readable`](https://nodejs.org/api/stream.html#stream_class_stream_readable) stream. Usage of `StreamedIncomingFrame`
allows you to receive chunks of data in real-time, instead of waiting for all chunks to be received.

The data type for this message is made available through the [`streamedMessage`](#streamedmessage) event, or also
through the `StreamedIncomingFrame#frameHeader.opcode` property. For example, if you have a `StreamedIncomingFrame`
object `frame`, you can obtain its data type using `frame.frameHeader.opcode`.

The `data` event is emitted when a chunk of data is received. If the data type is `Text`, the single argument is a UTF-8
encoded string. If it's `Binary`, then the single argument is a `Buffer`.

The `end` event is emitted when all data is received. Once `end` is emitted, no more `data` events will be emitted.

# Planned Features

- Server support
- [Per-message compression](https://tools.ietf.org/html/draft-ietf-hybi-permessage-compression-28)
