/**
 * Run this example and point it at an instance of the echo-server.ts example.
 */

import {FrameType, WebSocket} from '../src'; // use `import {...} from 'websocket13';` when installed from npm

let socket = new WebSocket('ws://127.0.0.1:8080', {
	protocols: ['foo', 'bar'] // supported subprotocols
});

let g_Interval = null;

socket.on('connected', (info) => {
	console.log(`Connected with status code ${info.responseCode} and protocol ${socket.protocol}`);

	console.log('SEND: Test message single-frame.');
	socket.send('Test message single-frame.');

	let i = 1;
	let stream = socket.createMessageStream(FrameType.Data.Text);
	let interval = setInterval(() => {
		stream.write(`Multi-frame message chunk #${i}\n`);

		if (i >= 20) {
			stream.end();
			clearInterval(interval);
		}

		i++;
	}, 50);

	console.log('SEND: This message will be sent (and echoed) after the stream is finished.');
	socket.send('This message will be sent (and echoed) after the stream is finished.');

	g_Interval = setInterval(() => {
		// Repeatedly send the current time
		socket.send(new Date().toString());
	}, 5000);
});

socket.on('message', (type, data) => {
	if (type == FrameType.Data.Text) {
		console.log(`Received single-frame text message: ${data}`);
	} else {
		console.log(`Received single-frame binary message of ${data.length} bytes`);
	}
});

socket.on('streamedMessage', (type, stream) => {
	console.log(`Receiving new streamed ${type == FrameType.Data.Text ? 'text' : 'binary'} message.`);
	stream.on('data', (chunk) => {
		process.stdout.write(`RCVD: ${chunk}`);
	});

	stream.on('end', () => {
		console.log('Streamed message complete.');
	});
});

socket.on('disconnected', (code, reason, initiatedByUs) => {
	console.log(`Disconnected with code ${code} and reason '${reason}'`);
	clearInterval(g_Interval);
});

socket.on('error', (err) => {
	console.log(`Disconnected due to error: ${err.message}`);
	clearInterval(g_Interval);
});
