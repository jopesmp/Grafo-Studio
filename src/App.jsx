import { useCallback, useState } from 'react';
import {
  ReactFlow, Background, Controls,
  applyNodeChanges, applyEdgeChanges, addEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// As peças e fios que aparecem ao abrir
const pecasIniciais = [
  { id: 't1', position: { x: 0, y: 0 },   data: { label: 'Trabalhador 1' } },
  { id: 's1', position: { x: 300, y: 0 }, data: { label: 'Supervisor 1' } },
];
const fiosIniciais = [{ id: 't1-s1', source: 't1', target: 's1' }];

export default function App() {
  const [pecas, setPecas] = useState(pecasIniciais);
  const [fios, setFios] = useState(fiosIniciais);

  // O que fazer quando o usuário arrasta, apaga ou liga peças
  const aoMudarPecas = useCallback((m) => setPecas((p) => applyNodeChanges(m, p)), []);
  const aoMudarFios = useCallback((m) => setFios((f) => applyEdgeChanges(m, f)), []);
  const aoLigar = useCallback((c) => setFios((f) => addEdge(c, f)), []);

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <ReactFlow
        nodes={pecas}
        edges={fios}
        onNodesChange={aoMudarPecas}
        onEdgesChange={aoMudarFios}
        onConnect={aoLigar}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}