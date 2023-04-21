import State from './enums/State';
import FrameType from './enums/FrameType';
import StatusCode from './enums/StatusCode';

import WebSocket from './WebSocket';
import WebSocketServer from './WebSocketServer';

import WebSocketServerConnection from './WebSocketServerConnection';
import StreamedIncomingMessage from './streams/StreamedIncomingMessage';
import StreamedOutgoingMessage from './streams/StreamedOutgoingMessage';

import {HandshakeData} from './interfaces-external';

export {
	// Enums
	State,
	FrameType,
	StatusCode,

	// Classes that consumers directly instantiate
	WebSocket,
	WebSocketServer,

	// Other classes that shouldn't be directly instantiated
	WebSocketServerConnection,
	StreamedIncomingMessage,
	StreamedOutgoingMessage,

	// TypeScript interfaces
	HandshakeData
};

// Also provide a default export
export default {
	// Enums
	State,
	FrameType,
	StatusCode,

	// Classes that consumers directly instantiate
	WebSocket,
	WebSocketServer
};
