import tap from 'tap';
import fs from 'fs';
import tls from 'tls';
import net from 'net';
import path from 'path';
import sslRootCas from 'ssl-root-cas';
import Pool from '../src/index';

class FakeParser extends Pool.ConnectionInterface {
  constructor(socket, ...rest) {
    super(socket, ...rest);
    socket.on('data', (data) => {
      this.emit('received', data);
    });
  }
}

const basePath = path.join(__dirname, 'certs', 'server');
let tlsServer;
let netServer;

tap.test('Should setup dummy TLS server', (t) => {
  sslRootCas
    .inject()
    .addFile(path.join(basePath, 'my-root-ca.crt.pem'));

  tlsServer = tls.createServer({
    key: fs.readFileSync(path.join(basePath, 'my-server.key.pem')),
    cert: fs.readFileSync(path.join(basePath, 'my-server.crt.pem')),
  }, (socket) => {
    // ECHO
    socket.pipe(socket);
    // Don't care about errors (e.g. disconnects) in the tests
    socket.on('error', () => null);
  });
  tlsServer.listen(0, (error) => {
    t.end(error);
  });
});

tap.test('Should setup dummy insecure server', (t) => {
  netServer = net.createServer({
    key: fs.readFileSync(path.join(basePath, 'my-server.key.pem')),
    cert: fs.readFileSync(path.join(basePath, 'my-server.crt.pem')),
  }, (socket) => {
    // ECHO
    socket.pipe(socket);
    // Don't care about errors (e.g. disconnects) in the tests
    socket.on('error', () => null);
  });
  netServer.listen(0, (error) => {
    t.end(error);
  });
});

tap.test('Should fail to connect with invalid cert', async (t) => {
  const pool = new Pool(() => { }, {
    name: 'InvalidCert',
    host: 'localhost',
    port: tlsServer.address().port,
    min: 0,
  });
  t.ok(pool, 'Constructor should work');
  try {
    await pool.acquire();
    t.ok(false, 'Acquire should throw');
  } catch (x) {
    t.ok(true, 'Acquire should throw');
  }
  await pool.destroyAllNow();
  t.ok(true, 'Pool should be destroyed.');
  t.end();
});

tap.test('Should make a secure pool', async (t) => {
  const pool = new Pool(FakeParser, {
    name: 'GoodCert',
    host: 'localhost',
    port: tlsServer.address().port,
    tlsOptions: {
      ca: fs.readFileSync(path.join(basePath, 'my-root-ca.crt.pem')),
    },
    max: 2,
  });
  t.ok(pool, 'Constructor should work');
  const connection = await pool.acquire();
  t.ok(connection, 'Should acquire connection.');
  const second = await pool.acquire();
  t.ok(second, 'Should acquire another.');
  pool.release(connection);
  const third = await pool.acquire();
  t.ok(third, 'Should get a third with max connections 2');
  pool.release(second);
  third.send(new Buffer('ABCD', 'ascii'));
  pool.release(third);
  const promise = new Promise((accept) => {
    third.once('received', (message) => {
      t.ok(message, 'Should receive message');
      t.equal(message.length, 4, 'Message length should be 4');
      accept();
    });
  });
  await promise;
  await pool.destroyAllNow();
  t.ok(true, 'Pool should be destroyed.');
  t.end();
});


tap.test('Should make an insecure pool', async (t) => {
  const pool = new Pool(FakeParser, {
    name: 'Insecure',
    host: 'localhost',
    port: netServer.address().port,
    insecure: true,
    max: 2,
  });
  t.ok(pool, 'Constructor should work');
  const connection = await pool.acquire();
  t.ok(connection, 'Should acquire connection.');
  const second = await pool.acquire();
  t.ok(second, 'Should acquire another.');
  pool.release(connection);
  const third = await pool.acquire();
  t.ok(third, 'Should get a third with max connections 2');
  pool.release(second);
  third.send(new Buffer('ABCD', 'ascii'));
  pool.release(third);
  const promise = new Promise((accept) => {
    third.once('received', (message) => {
      t.ok(message, 'Should receive message');
      t.equal(message.length, 4, 'Message length should be 4');
      accept();
    });
  });
  await promise;
  await pool.destroyAllNow();
  t.ok(true, 'Pool should be destroyed.');
  t.end();
});

tap.test('Should destroy tls server', (t) => {
  tlsServer.close(() => {
    t.end();
  });
});

tap.test('Should destroy net server', (t) => {
  netServer.close(() => {
    t.end();
  });
});
