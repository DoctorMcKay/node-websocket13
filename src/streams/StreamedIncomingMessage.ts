import {Readable} from 'stream';

import FrameType from '../enums/FrameType';
import {WsFrame} from '../interfaces-internal';

export default class StreamedIncomingMessage extends Readable {
	frameHeader: WsFrame;

	_dispatched: boolean;
	_reading: boolean;
	_frames: WsFrame[];

	constructor(frame: WsFrame, dispatch: boolean) {
		let frameHeader = Object.assign({}, frame);
		frameHeader.payload = Buffer.alloc(0);
		frameHeader.payloadLength = 0;

		super({
			encoding: frameHeader.opcode == FrameType.Data.Text ? 'utf8' : null
		});

		this.frameHeader = frameHeader;
		this._dispatched = dispatch; // did this frame get sent to the user? if false, they don't have an event listener for 'streamedMessage'
		this._reading = false;
		this._frames = [];

		this._frame(frame);
	}

	_read(size) {
		this._reading = true;
		this._dispatch();
	}

	_frame(frame) {
		this._frames.push(frame);
		this._dispatch();
	}

	_dispatch() {
		if (!this._dispatched && this._frames[this._frames.length - 1].FIN) {
			// We have all the data
			this.emit('end', Buffer.concat(this._frames.map(frame => frame.payload).filter(payload => !!payload)));
		}

		if (!this._reading) {
			return;
		}

		let frame, keepReading;

		while (this._frames.length > 0) {
			frame = this._frames.splice(0, 1)[0];
			keepReading = this.push(frame.payload);

			if (frame.FIN) {
				this.push(null);
			}

			if (!keepReading) {
				return;
			}
		}
	}
}
