import tls from 'tls';
import net from 'net';
import pool from 'generic-pool';
import { EventEmitter } from 'events';

class ConnectionInterface extends EventEmitter {
  constructor(socket, id) {
    super();
    this.id = id;
    this.socket = socket;
    this.socket.on('error', e => this.emit('error', e));
    this.socket.on('close', e => this.emit('close', e));
  }

  send(buffer) {
    this.socket.write(buffer);
  }

  destroy() {
    this.socket.destroy();
  }

  end() {
    this.socket.end();
  }

  get readyState() {
    return this.socket.readyState;
  }
}

const noOpLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export default class TcpPool {
  constructor(interfaceConstructor, options) {
    this.Parser = interfaceConstructor;
    this.options = Object.assign({}, options);
    this.name = this.options.name || `${interfaceConstructor.name} Connection Pool`;
    this.connectionCount = 0;

    const factory = {
      create: () => this.connect(),
      destroy: client => this.disconnect(client),
      validate: client => this.validate(client),
    };
    const config = {
      max: this.options.max || 10,
      min: this.options.min || 1,
      acquireTimeoutMillis: this.options.acquireTimeoutMillis || 15000,
      idleTimeoutMillis: this.options.idleTimeoutMillis || 30000,
      testOnBorrow: true,
    };
    this.pool = pool.createPool(factory, config);
  }

  async acquire(context) {
    const logger = this.loggerForContext(context);
    logger.info('Acquiring connection from pool', { name: this.name });
    try {
      const conn = await this.pool.acquire();
      logger.info('Returning connection from pool', {
        id: conn.id,
        name: this.name,
      });
      conn.context = context;
      return conn;
    } catch (error) {
      logger.error('Failed to acquire connection from pool', {
        name: this.name,
        error: error.message || error,
      });
      throw error;
    }
  }

  release(conn) {
    const logger = this.loggerForContext(conn.context);
    logger.info('Releasing connection into pool', {
      id: conn.id,
      name: this.name,
    });
    this.reset(conn);
    // eslint-disable-next-line no-param-reassign
    delete conn.context;
    this.pool.release(conn);
  }

  destroy(conn) {
    const logger = this.loggerForContext(conn.context);
    logger.info('Destroying connection of pool', {
      id: conn.id,
      name: this.name,
    });
    this.reset(conn);
    // eslint-disable-next-line no-param-reassign
    delete conn.context;
    this.pool.destroy(conn);
  }

  async destroyAllNow() {
    this.loggerForContext().info('Pool shutting down', { name: this.name });
    await this.pool.drain();
    this.loggerForContext().info('Pool drained', { name: this.name });
    await this.pool.clear();
    this.loggerForContext().info('Pool cleared', { name: this.name });
  }

  async connect() {
    this.connectionCount += 1;
    const myId = this.connectionCount;
    this.loggerForContext().info('Pool socket connecting', { name: this.name, id: myId });
    let attemptCompleted = false;
    let socket;

    return new Promise((accept, reject) => {
      let resolved = false;
      const connectionHandler = async () => {
        if (!attemptCompleted) {
          this.loggerForContext().info('Pool socket connected', { name: this.name, id: myId });
          attemptCompleted = true;
          socket.removeAllListeners();
          const connectionParser = new (this.Parser)(socket, myId);
          if (typeof connectionParser.initializeConnection === 'function') {
            try {
              await connectionParser.initializeConnection();
            } catch (error) {
              reject(error);
              return;
            }
          }
          this.reset(connectionParser);
          resolved = true;
          accept(connectionParser);
        }
      };

      try {
        if (this.options.insecure === true) {
          socket = net.connect({
            host: this.options.host,
            port: this.options.port,
          }, connectionHandler);
        } else {
          const tlsOptions = Object.assign({
            secureProtocol: 'TLSv1_2_client_method',
            host: this.options.host,
            port: this.options.port,
          }, this.options.tlsOptions);
          socket = tls.connect(tlsOptions, connectionHandler);
        }

        socket.once('error', (error) => {
          this.loggerForContext().error('Error on Pool socket', {
            id: myId,
            name: this.name,
            message: error.message,
            stack: error.stack,
          });
          if (!attemptCompleted) {
            attemptCompleted = true;
            socket.end();
            // Reject after a second to give some backoff time
            if (!resolved) {
              setTimeout(() => reject(error), 1000);
              resolved = true;
            }
          }
        });
      } catch (error) {
        this.loggerForContext().error('Error on Pool', {
          name: this.name,
          message: error.message,
          stack: error.stack,
        });
        if (!resolved) {
          reject(error);
        }
      }
    });
  }

  loggerForContext(context) {
    if (this.options.loggerFromContext) {
      return this.options.loggerFromContext(context) || noOpLogger;
    }
    return this.options.logger || noOpLogger;
  }

  reset(conn) {
    conn.removeAllListeners();
    conn.on('error', error => this.onError(conn, error));
    conn.on('close', error => this.onClose(conn, error));
  }

  onError(conn, error) {
    const logger = this.loggerForContext(conn.context);
    logger.error('Error on Pool socket', {
      id: conn.id,
      name: this.name,
      message: error.message,
      stack: error.stack,
    });
    conn.end();
    this.pool.destroy(conn);
  }

  onClose(conn) {
    const logger = this.loggerForContext(conn.context);
    logger.info('Pool socket closed', {
      id: conn.id,
      name: this.name,
    });
  }

  validate(conn) {
    return new Promise((accept) => {
      if (typeof conn.validate === 'function') {
        Promise.resolve(conn.validate())
          .then(isValid => accept(isValid));
      } else {
        if (conn.readyState === 'open') {
          accept(true);
          return;
        }
        this.loggerForContext(conn.context).error('Invalid connection in Pool socket', {
          id: conn.id,
          name: this.name,
        });
        accept(false);
      }
    });
  }

  disconnect(conn) {
    return new Promise((accept, reject) => {
      try {
        this.loggerForContext().debug('Pool socket closing', {
          name: this.name,
          id: conn.id,
        });
        conn.destroy();
        accept();
      } catch (error) {
        reject(error);
      }
    });
  }
}

TcpPool.ConnectionInterface = ConnectionInterface;
