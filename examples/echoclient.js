/**
 * Run this example and point it at echo.websocket.org or an instance of the echoserver.js example.
 */

var WS13 = require('../lib/index.js'); // use require('websocket13') when installed from npm

var socket = new WS13.WebSocket('ws://echo.websocket.org', {
	"protocols": ["foo", "bar"] // supported subprotocols
});

socket.on('connected', (info) => {
	console.log("Connected with status code " + info.responseCode + " and protocol " + socket.protocol);

	console.log("SEND: Test message single-frame.");
	socket.send("Test message single-frame.");

	var i = 1;
	var stream = socket.createMessageStream(WS13.FrameType.Data.Text);
	var interval = setInterval(() => {
		stream.write("Multi-frame message chunk #" + i + "\n");

		if (i >= 20) {
			stream.end();
			clearInterval(interval);
		}

		i++;
	}, 50);

	console.log("SEND: This message will be sent (and echoed) after the stream is finished.");
	socket.send("This message will be sent (and echoed) after the stream is finished.");
});

socket.on('message', (type, data) => {
	if (type == WS13.FrameType.Data.Text) {
		console.log("Received single-frame text message: " + data);
	} else {
		console.log("Received single-frame binary message of " + data.length + " bytes");
	}
});

socket.on('streamedMessage', (type, stream) => {
	console.log("Receiving new streamed " + (type == WS13.FrameType.Data.Text ? "text" : "binary") + " message.");
	stream.on('data', (chunk) => {
		process.stdout.write("RCVD: " + chunk);
	});

	stream.on('end', () => {
		console.log("Streamed message complete.");
	})
});
