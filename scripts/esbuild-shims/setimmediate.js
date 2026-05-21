"use strict";

const scope = globalThis;

if (typeof scope.setImmediate !== "function") {
  scope.setImmediate = function setImmediateShim(callback, ...args) {
    return setTimeout(() => {
      callback(...args);
    }, 0);
  };
}

if (typeof scope.clearImmediate !== "function") {
  scope.clearImmediate = function clearImmediateShim(handle) {
    clearTimeout(handle);
  };
}
