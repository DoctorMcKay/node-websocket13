import WebSocketExtensions from 'websocket-extensions';
import {WebSocketClientConnectionOptions} from './interfaces-external';

export interface BaseWebSocketOptions {
	pingInterval?: number;
	pingTimeout?: number;
	pingFailures?: number;
	protocols?: string[];
	permessageDeflate?: boolean;
}

export interface WebSocketClientConnectionOptionsInternal extends WebSocketClientConnectionOptions {
	headers?: {[name: string]: string|number};
	protocol: string;
	port: number;
}

export interface TxStats {
	wire: number;
	preExt: number;
}

export interface RxStats {
	wire: number;
	postExt: number;
}

export interface WebSocketStats {
	tx: TxStats;
	rx: RxStats;
}

export interface WsFrame {
	FIN: boolean;
	RSV1: boolean;
	RSV2: boolean;
	RSV3: boolean;
	opcode: number;
	payloadLength: number;
	maskKey?: number;
	payload: Buffer;
}

export interface WsExtensionFrame {
	final: boolean;
	rsv1: boolean;
	rsv2: boolean;
	rsv3: boolean;
	opcode: number;
	masked: boolean;
	maskingKey: number;
	payload: Buffer;
}

export interface WsExtensionMessage {
	rsv1: boolean;
	rsv2: boolean;
	rsv3: boolean;
	opcode: number;
	data: Buffer;
}
