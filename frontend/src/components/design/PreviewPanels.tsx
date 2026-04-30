import React, { useState } from 'react';

interface CodePreviewProps {
  code: Map<string, string>;
  activeFile: string;
  onFileSelect: (file: string) => void;
}

export const CodePreview: React.FC<CodePreviewProps> = ({ code, activeFile, onFileSelect }) => {
  const activeCode = code.get(activeFile) || '';

  return (
    <div className="code-preview h-full flex">
      <div className="w-48 border-r border-border overflow-y-auto">
        <div className="p-2 text-xs font-medium text-muted-foreground uppercase">
          Files
        </div>
        {[...code.keys()].map((file) => (
          <button
            key={file}
            onClick={() => onFileSelect(file)}
            className={`w-full text-left px-3 py-2 text-sm truncate ${
              file === activeFile
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-secondary'
            }`}
          >
            {file}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4 bg-[#1e1e1e]">
        <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">
          {activeCode}
        </pre>
      </div>
    </div>
  );
};

interface PreviewPanelProps {
  src?: string;
  html?: string;
}

export const PreviewPanel: React.FC<PreviewPanelProps> = ({ src, html }) => {
  return (
    <div className="preview-panel h-full bg-white rounded-lg overflow-hidden">
      {src ? (
        <img src={src} alt="Preview" className="w-full h-full object-contain" />
      ) : html ? (
        <iframe
          srcDoc={html}
          className="w-full h-full border-0"
          sandbox="allow-scripts"
        />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          No preview available
        </div>
      )}
    </div>
  );
};

interface ComparisonViewProps {
  original: string;
  generated: string;
  score: number;
}

export const ComparisonView: React.FC<ComparisonViewProps> = ({
  original,
  generated,
  score,
}) => {
  const [active, setActive] = useState<'side' | 'overlay'>('side');

  return (
    <div className="comparison-view h-full flex flex-col">
      <div className="flex items-center justify-between p-2 border-b border-border">
        <div className="flex gap-2">
          <button
            onClick={() => setActive('side')}
            className={`px-3 py-1 text-xs rounded ${
              active === 'side' ? 'bg-primary text-white' : 'bg-secondary'
            }`}
          >
            Side by Side
          </button>
          <button
            onClick={() => setActive('overlay')}
            className={`px-3 py-1 text-xs rounded ${
              active === 'overlay' ? 'bg-primary text-white' : 'bg-secondary'
            }`}
          >
            Overlay
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm">Similarity:</span>
          <span className={`font-bold ${
            score >= 85 ? 'text-green-500' : score >= 70 ? 'text-yellow-500' : 'text-red-500'
          }`}>
            {score.toFixed(1)}%
          </span>
        </div>
      </div>

      {active === 'side' ? (
        <div className="flex-1 flex">
          <div className="flex-1 border-r border-border">
            <div className="p-2 text-xs text-muted-foreground bg-secondary">Original</div>
            <img src={original} alt="Original" className="w-full h-full object-contain" />
          </div>
          <div className="flex-1">
            <div className="p-2 text-xs text-muted-foreground bg-secondary">Generated</div>
            <img src={generated} alt="Generated" className="w-full h-full object-contain" />
          </div>
        </div>
      ) : (
        <div className="flex-1 relative">
          <img src={original} alt="Original" className="absolute inset-0 w-full h-full object-contain opacity-30" />
          <img src={generated} alt="Generated" className="absolute inset-0 w-full h-full object-contain" />
        </div>
      )}
    </div>
  );
};

export default { CodePreview, PreviewPanel, ComparisonView };