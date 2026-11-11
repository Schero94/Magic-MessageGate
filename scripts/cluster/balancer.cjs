'use strict';
// Non-sticky round-robin TCP balancer for the cluster acceptance run: every new
// connection goes to the next Strapi process (MG_CLUSTER_PORTS) in turn.
const net = require('node:net');

const listen = Number(process.env.MG_CLUSTER_BALANCER_PORT || 1480);
const ports = (process.env.MG_CLUSTER_PORTS || '1491,1492,1493,1494,1495,1496,1497,1498').split(',').map(Number);
let next = 0;
net
  .createServer((client) => {
    const backend = net.connect(ports[next++ % ports.length], '127.0.0.1');
    client.pipe(backend).pipe(client);
    const close = () => {
      client.destroy();
      backend.destroy();
    };
    client.on('error', close);
    backend.on('error', close);
  })
  .listen(listen, '127.0.0.1', () => console.log(`balancer on ${listen} -> ${ports.join(',')}`));
