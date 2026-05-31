'use strict';

// Thin Socket.io wrapper — mirrors the Roller pattern.
// Usage: connectSocket(url), emit(event, data), on(event, cb)

let _socket = null;

function connectSocket(serverUrl) {
  _socket = io(serverUrl, { transports: ['websocket', 'polling'] });
  return _socket;
}

function emit(event, data) {
  if (!_socket) return;
  _socket.emit(event, data);
}

function on(event, cb) {
  if (!_socket) return;
  _socket.on(event, cb);
}

function off(event, cb) {
  if (!_socket) return;
  _socket.off(event, cb);
}

function socketId() {
  return _socket?.id ?? null;
}
