import tls from 'tls';
import winston from 'winston';
import { Pool } from 'generic-pool';
import { EventEmitter } from 'events';

class ConnectionInterface extends EventEmitter {
  constructor(socket, id) {
    super();
    this.id = id;
    this.socket = socket;
    this.socket.on('error', e => this.emit('error', e));
    this.socket.on('close', e => this.emit('closed', e));
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

export default class TcpPool {
  constructor(interfaceConstructor, options) {
    this.Parser = interfaceConstructor;
    this.options = Object.assign({}, options);
    this.name = this.options.name || `${interfaceConstructor.name} Connection Pool`;
    this.connectionCount = 0;
    this.pool = new Pool({
      name: this.name,
      create: callback => this.connect(callback),
      destroy: client => this.disconnect(client),
      validate: client => this.validate(client),
      max: this.options.max || 10,
      min: this.options.min || 1,
      idleTimeoutMillis: 30000,
      log: (msg, level) => {
        try {
          winston[level](`Pool ${this.name} ${msg}`);
        } catch (logError) {
          winston.error('Logging failed', { message: logError.message, stack: logError.stack });
        }
      },
    });
  }

  async acquire(context) {
    return new Promise((accept, reject) => {
      this.pool.acquire((err, conn) => {
        if (err) {
          return reject(err);
        }
        // eslint-disable-next-line no-param-reassign
        conn.context = context;
        return accept(conn);
      });
    });
  }

  release(conn) {
    this.reset(conn);
    // eslint-disable-next-line no-param-reassign
    delete conn.context;
    this.pool.release(conn);
  }

  async destroyAllNow() {
    winston.debug(`Pool ${this.name} shutting down`);
    return new Promise((accept) => {
      this.pool.drain(() => {
        winston.debug(`Pool ${this.name} drained`);
        this.pool.destroyAllNow();
        accept();
      });
    });
  }

  connect(callback) {
    this.connectionCount += 1;
    const myId = this.connectionCount;
    winston.info(`Pool ${this.name} socket #${myId} connecting`);
    let attemptCompleted = false;
    const tlsOptions = Object.assign({
      secureProtocol: 'TLSv1_2_client_method',
      host: this.options.host,
      port: this.options.port,
    }, this.options.tlsOptions);
    const socket = tls.connect(tlsOptions, () => {
      if (!attemptCompleted) {
        winston.info(`Pool ${this.name} socket #${myId} connected`);
        attemptCompleted = true;
        socket.removeAllListeners();
        const connectionParser = new (this.Parser)(socket, myId);
        this.reset(connectionParser);
        callback(null, connectionParser);
      }
    });
    socket.once('error', (error) => {
      winston.error(`Error on Pool ${this.name} socket #${myId}`, {
        message: error.message,
        stack: error.stack,
      });
      if (!attemptCompleted) {
        attemptCompleted = true;
        socket.end();
        callback(error);
      }
    });
  }

  reset(conn) {
    conn.removeAllListeners();
    conn.on('error', error => this.onError(conn, error));
    conn.on('closed', error => this.onClosed(conn, error));
  }

  onError(conn, error) {
    winston.error(`Error on Pool ${this.name} socket #${conn.id}`, {
      message: error.message,
      stack: error.stack,
    });
    conn.end();
  }

  onClosed(conn) {
    winston.debug(`Pool ${this.name} socket #${conn.id} closed`);
  }

  validate(conn) {
    if (conn.readyState === 'open') {
      return true;
    }
    winston.error(`Invalid connection in Pool ${this.name} socket #${conn.id}`);
    return false;
  }

  disconnect(conn) {
    winston.debug(`Pool ${this.name} socket #${conn.id} closing`);
    conn.destroy();
  }
}

TcpPool.ConnectionInterface = ConnectionInterface;
