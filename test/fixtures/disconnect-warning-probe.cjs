"use strict";
// Disconnects IPC, then raises a warning: the forwarder must stay silent.
process.disconnect();
process.emitWarning("y");
