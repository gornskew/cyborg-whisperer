/*
 * Copyright © 2026 Gornskew Enterprises
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.  Distributed WITHOUT
 * ANY WARRANTY; see <https://www.gnu.org/licenses/agpl-3.0.html>.
 */

/**
 * initialize.js
 *
 * Handler for MCP initialize request
 *
 * The result carries the backend's own `instructions` when it serves
 * them at ${BASE_PATH}/instructions (plain text or markdown).  MCP
 * clients put a server's instructions in the agent's system prompt, so
 * this is the one piece of backend guidance an agent sees before it
 * calls any tool.  A backend without the endpoint, or one that does not
 * answer within a few seconds (still booting), initializes exactly as
 * before, with no instructions.
 */

const { sendResponse } = require('./index');
const { getBackendConnectionInfo, makeHttpRequest } = require('../lib/server');

/** Idle timeout for the instructions fetch; initialize must stay quick. */
const INSTRUCTIONS_TIMEOUT_MS = 3000;

/** Instructions longer than this are cut: they ride in every system prompt. */
const INSTRUCTIONS_MAX_CHARS = 4000;

function fetchInstructions(config, logger, callback) {
  const { hostname, port } = getBackendConnectionInfo(config, logger);
  const options = {
    hostname,
    port,
    path: `${config.BASE_PATH}/instructions`,
    method: 'GET',
    timeoutMs: INSTRUCTIONS_TIMEOUT_MS
  };

  makeHttpRequest(options, null, (error, response) => {
    if (error || !response || response.statusCode !== 200) {
      logger.info(`No backend instructions (${error ? error.message : 'status ' + (response && response.statusCode)})`);
      callback(null);
      return;
    }
    const text = String(response.content || '').trim();
    callback(text ? text.substring(0, INSTRUCTIONS_MAX_CHARS) : null);
  }, 'INSTRUCTIONS', logger);
}

/**
 * Handle MCP initialize request
 */
function handleInitialize(request, config, logger) {
  logger.info('Handling initialize request');

  fetchInstructions(config, logger, (instructions) => {
    const result = {
      protocolVersion: request.params?.protocolVersion || '0.1.0',
      capabilities: {
        experimental: {},
        prompts: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        tools: { listChanged: false }
      },
      serverInfo: {
        name: config.SERVER_NAME,
        version: config.VERSION
      }
    };
    if (instructions) result.instructions = instructions;

    sendResponse({ jsonrpc: '2.0', id: request.id, result }, logger);
    logger.info(`Initialization complete${instructions ? ' (with backend instructions)' : ''}`);
  });
}

module.exports = { handleInitialize };
