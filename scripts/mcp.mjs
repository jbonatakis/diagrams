import { connectMCP } from './oauth.mjs';

const connection = await connectMCP();
const { client } = connection;
try {
  const tool = process.argv[2] ?? 'get_diagram';
  if (tool === 'login') {
    console.log('Paired. This CLI will remember the connection.');
  } else if (tool === 'tools') {
    console.log(JSON.stringify(await client.listTools(), null, 2));
  } else if (tool === 'demo') {
    const read = await client.callTool({ name: 'get_diagram', arguments: {} });
    if (read.isError) throw new Error(JSON.stringify(read.content));
    const state = read.structuredContent ?? JSON.parse(read.content[0].text);
    const suffix = Date.now().toString(36);
    const first = `browser_${suffix}`;
    const second = `agent_${suffix}`;
    const result = await client.callTool({ name: 'apply_operations', arguments: {
      diagramId: state.diagramId, expectedRevision: state.revision,
      operations: [
        { op: 'create_shape', id: first, shape: 'rectangle', x: 180, y: 180, label: 'Your browser', fill: '#e9f0e5' },
        { op: 'create_shape', id: second, shape: 'rectangle', x: 520, y: 180, label: 'Your agent', fill: '#eee9f7' },
        { op: 'connect', id: `connection_${suffix}`, fromId: first, toId: second },
      ],
    } });
    console.log(JSON.stringify(result, null, 2));
    if (result.isError) process.exitCode = 1;
  } else {
    const input = process.argv[3] ? JSON.parse(process.argv[3]) : {};
    const result = await client.callTool({ name: tool, arguments: input });
    console.log(JSON.stringify(result, null, 2));
    if (result.isError) process.exitCode = 1;
  }
} finally {
  await connection.close();
}
