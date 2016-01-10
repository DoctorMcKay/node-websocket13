var WS13 = require('./index.js');

var Writable = require('stream').Writable;
var ByteBuffer = require('bytebuffer');

module.exports = StreamedFrame;

require('util').inherits(StreamedFrame, Writable);

function StreamedFrame(socket, type) {
	this.started = false;
	this.finished = false;
	this.dataSent = false;
	this.type = type;
	this._socket = socket;
	this._chunks = [];

	Writable.call(this);

	this.setDefaultEncoding("binary");
}

StreamedFrame.prototype._start = function() {
	if (this.started) {
		return;
	}

	this.started = true;

	this._emptyQueue();
};

StreamedFrame.prototype._emptyQueue = function(end) {
	if (!this.started || this._chunks.length == 0) {
		return;
	}

	// No reason not to combine all those chunks into one
	var buffer = Buffer.concat(this._chunks.map(chunk => chunk.payload));
	this._socket._sendFrame({
		"FIN": !!end,
		"RSV1": false,
		"RSV2": false,
		"RSV3": false,
		"opcode": !this.dataSent ? this.type : WS13.FrameType.Continuation,
		"payload": buffer
	}, true);

	this.dataSent = true;

	this._chunks.forEach(chunk => chunk.callback(null));
	this._chunks = [];

	this.finished = !!end;

	this._socket._processQueue();
};

StreamedFrame.prototype.write = function() {
	// Yes, we empty the queue before we push this chunk into it for a reason
	// At least the echo.websocket.org server (and possibly others) rejects any frame with an empty payload, despite
	// this being perfectly valid. For that reason, we save at least one chunk to send in our FIN frame.

	// We have to empty the queue *BEFORE* write() gets to the underlying Writable, as _write() won't be called
	// until the last chunk's callback has fired. This means that the queue will only ever contain 1 item, but nothing
	// says that node couldn't change this behavior in the future. Plus I'm fed up so I'm leaving it this way.
	this._emptyQueue();
	Writable.prototype.write.apply(this, arguments);
};

StreamedFrame.prototype._write = function(chunk, encoding, callback) {
	if (this.type == WS13.FrameType.Data.Binary && typeof chunk === 'string') {
		callback(new Error("Cannot send a string through a binary frame."));
		this.end();
		return;
	}

	if (ByteBuffer.isByteBuffer(chunk)) {
		chunk = chunk.toBuffer();
	}

	this._chunks.push({
		"payload": chunk,
		"callback": callback
	});
};

StreamedFrame.prototype.end = function() {
	this._emptyQueue(true);
	Writable.prototype.end.apply(this, arguments);
};
