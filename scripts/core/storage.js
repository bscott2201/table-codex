import { logger } from "./logger.js";

export function getJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    logger.error(`storage.getJson failed for key "${key}":`, err);
    return fallback;
  }
}

export function setJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    logger.error(`storage.setJson failed for key "${key}":`, err);
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    logger.error(`storage.remove failed for key "${key}":`, err);
  }
}

export function getString(key, fallback = "") {
  try {
    const val = localStorage.getItem(key);
    return val !== null ? val : fallback;
  } catch (err) {
    logger.error(`storage.getString failed for key "${key}":`, err);
    return fallback;
  }
}

export function setString(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    logger.error(`storage.setString failed for key "${key}":`, err);
  }
}
