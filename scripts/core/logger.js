const PREFIX = "[TableCodex]";

export const logger = {
  log(...args) {
    console.log(PREFIX, ...args);
  },
  warn(...args) {
    console.warn(PREFIX, ...args);
  },
  error(...args) {
    console.error(PREFIX, ...args);
  },
};
