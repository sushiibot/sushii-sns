import pino from "pino";
import config from "./config/config";

const logger = pino({
  level: config.LOG_LEVEL,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

logger.info(
  {
    level: logger.level,
  },
  "Logger initialized"
);

export default logger;
