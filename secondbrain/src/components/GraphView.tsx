import React, { useState, useEffect, useRef } from 'react';
import { Note, NoteCategory } from '../types/index.ts';
import { SHELVES } from '../utils/shelves.ts';
import { Network, Search, ExternalLink, RefreshCw } from 'lucide-react';

interface GraphViewProps {
  notes: Note[];
  onSelectNote: (noteId: string) => void;
}

interface NodeData {
  id: string;
  title: string;
  category: NoteCategory;
  tags: string[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface LinkData {
  source: string;
  target: string;
  commonTag?: string;
}

export const GraphView: React.FC<GraphViewProps> = ({ notes, onSelectNote }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<NodeData | null>(null);
  const [hoveredNode, setHoveredNode] = useState<NodeData | null>(null);

  const categoryColors = Object.fromEntries(SHELVES.map((s) => [s.id, s.color])) as Record<NoteCategory, string>;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    const width = canvas.width;
    const height = canvas.height;

    // Build Nodes
    const nodes: NodeData[] = notes.map((note, index) => {
      const angle = (index / Math.max(1, notes.length)) * Math.PI * 2;
      const distance = 150 + (index % 3) * 60;
      return {
        id: note.id,
        title: note.title,
        category: note.category,
        tags: note.tags,
        x: width / 2 + Math.cos(angle) * distance + (Math.random() - 0.5) * 40,
        y: height / 2 + Math.sin(angle) * distance + (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        radius: Math.max(8, Math.min(18, 8 + Math.log2(note.content.length + 1) * 1.2)),
      };
    });

    // Build Links based on shared tags or same category
    const links: LinkData[] = [];
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        const noteA = notes[i];
        const noteB = notes[j];

        // Shared tag
        const commonTags = noteA.tags.filter((t) => noteB.tags.includes(t));
        if (commonTags.length > 0) {
          links.push({
            source: noteA.id,
            target: noteB.id,
            commonTag: commonTags[0],
          });
        } else if (noteA.category === noteB.category && (i % 2 === 0 || j % 2 === 0)) {
          // Category link
          links.push({
            source: noteA.id,
            target: noteB.id,
          });
        }
      }
    }

    // Gentle 2D simulation loop
    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Simulation physics step
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];

        // Center gravity
        const dx = width / 2 - n.x;
        const dy = height / 2 - n.y;
        n.vx += dx * 0.0003;
        n.vy += dy * 0.0003;

        // Node repulsion
        for (let j = i + 1; j < nodes.length; j++) {
          const m = nodes[j];
          const distDx = m.x - n.x;
          const distDy = m.y - n.y;
          const dist = Math.sqrt(distDx * distDx + distDy * distDy) || 1;
          if (dist < 140) {
            const force = (140 - dist) / 140;
            const fx = (distDx / dist) * force * 0.3;
            const fy = (distDy / dist) * force * 0.3;
            n.vx -= fx;
            n.vy -= fy;
            m.vx += fx;
            m.vy += fy;
          }
        }

        // Link spring attraction
        for (const link of links) {
          if (link.source === n.id) {
            const targetNode = nodes.find((no) => no.id === link.target);
            if (targetNode) {
              const lx = targetNode.x - n.x;
              const ly = targetNode.y - n.y;
              n.vx += lx * 0.001;
              n.vy += ly * 0.001;
            }
          }
        }

        // Damping
        n.vx *= 0.88;
        n.vy *= 0.88;

        n.x += n.vx;
        n.y += n.vy;

        // Boundaries
        n.x = Math.max(n.radius + 10, Math.min(width - n.radius - 10, n.x));
        n.y = Math.max(n.radius + 10, Math.min(height - n.radius - 10, n.y));
      }

      // Draw Links
      for (const link of links) {
        const sourceNode = nodes.find((n) => n.id === link.source);
        const targetNode = nodes.find((n) => n.id === link.target);
        if (!sourceNode || !targetNode) continue;

        const isHighlighted =
          hoveredNode &&
          (hoveredNode.id === sourceNode.id || hoveredNode.id === targetNode.id);

        ctx.beginPath();
        ctx.moveTo(sourceNode.x, sourceNode.y);
        ctx.lineTo(targetNode.x, targetNode.y);
        ctx.strokeStyle = isHighlighted
          ? 'rgba(52, 211, 153, 0.6)'
          : link.commonTag
          ? 'rgba(255, 255, 255, 0.12)'
          : 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = isHighlighted ? 1.5 : 1;
        ctx.stroke();
      }

      // Draw Nodes
      for (const n of nodes) {
        const isHovered = hoveredNode?.id === n.id;
        const isMatchesQuery =
          searchQuery.trim() === '' ||
          n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          n.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));

        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + (isHovered ? 4 : 0), 0, Math.PI * 2);
        ctx.fillStyle = isMatchesQuery
          ? categoryColors[n.category] || '#94a3b8'
          : 'rgba(75, 85, 99, 0.3)';
        ctx.fill();

        if (isHovered) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Text label
        if (isMatchesQuery) {
          ctx.font = isHovered
            ? '600 12px "Plus Jakarta Sans Variable", "Plus Jakarta Sans", sans-serif'
            : '11px "Plus Jakarta Sans Variable", "Plus Jakarta Sans", sans-serif';
          ctx.fillStyle = isHovered ? '#ffffff' : '#a3a3a3';
          ctx.textAlign = 'center';
          ctx.fillText(
            n.title.length > 20 ? `${n.title.slice(0, 18)}...` : n.title,
            n.x,
            n.y + n.radius + 14
          );
        }
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    // Mouse interaction handler
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left) * (width / rect.width);
      const mouseY = (e.clientY - rect.top) * (height / rect.height);

      let found: NodeData | null = null;
      for (const n of nodes) {
        const dist = Math.hypot(n.x - mouseX, n.y - mouseY);
        if (dist <= n.radius + 6) {
          found = n;
          break;
        }
      }
      setHoveredNode(found);
      canvas.style.cursor = found ? 'pointer' : 'default';
    };

    const handleClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left) * (width / rect.width);
      const mouseY = (e.clientY - rect.top) * (height / rect.height);

      for (const n of nodes) {
        const dist = Math.hypot(n.x - mouseX, n.y - mouseY);
        if (dist <= n.radius + 6) {
          setSelectedNode(n);
          break;
        }
      }
    };

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('click', handleClick);

    return () => {
      cancelAnimationFrame(animationFrameId);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('click', handleClick);
    };
  }, [notes, searchQuery]);

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] bg-neutral-950 overflow-hidden relative">
      {/* Top Controls Overlay */}
      <div className="absolute top-4 left-6 right-6 z-10 flex items-center justify-between pointer-events-none">
        <div className="flex items-center gap-3 pointer-events-auto">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-neutral-900/90 border border-neutral-800 backdrop-blur-md">
            <Network className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-semibold text-white">Knowledge Graph</span>
            <span className="text-xs text-neutral-500 font-mono">({notes.length} nodes)</span>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-neutral-500 absolute left-2.5 top-2.5 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Highlight note or tag..."
              className="pl-8 pr-3 py-1.5 bg-neutral-900/90 border border-neutral-800 rounded-lg text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-600 backdrop-blur-md w-48"
            />
          </div>
        </div>

        {/* Category Legend */}
        <div className="hidden sm:flex items-center gap-3 px-3 py-1.5 rounded-lg bg-neutral-900/90 border border-neutral-800 backdrop-blur-md pointer-events-auto text-[11px] text-neutral-400 font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
            <span>Projects</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            <span>Areas</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
            <span>Resources</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-500" />
            <span>Inbox</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-neutral-500" />
            <span>Archives</span>
          </div>
        </div>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={1400}
        height={900}
        className="w-full h-full block bg-neutral-950"
      />

      {/* Selected Node Details Drawer */}
      {selectedNode && (
        <div className="absolute bottom-6 right-6 z-10 w-80 p-4 bg-neutral-900/95 border border-neutral-800 rounded-xl shadow-2xl backdrop-blur-md space-y-3 animate-in fade-in slide-in-from-bottom-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400 capitalize">
                {selectedNode.category}
              </span>
              <h3 className="text-sm font-semibold text-white leading-snug">
                {selectedNode.title}
              </h3>
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-neutral-500 hover:text-white text-xs"
            >
              ✕
            </button>
          </div>

          {selectedNode.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 text-[11px] text-neutral-400 font-mono">
              {selectedNode.tags.map((t) => (
                <span key={t} className="px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-700">
                  #{t}
                </span>
              ))}
            </div>
          )}

          <div className="pt-2 border-t border-neutral-800 flex justify-end">
            <button
              onClick={() => onSelectNote(selectedNode.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-neutral-900 bg-white hover:bg-neutral-100 rounded-lg transition-colors"
            >
              <span>Open in Editor</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
