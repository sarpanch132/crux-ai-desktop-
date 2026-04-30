import React, { useState, useCallback, useRef } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface DesignInputProps {
  onFigmaLink?: (link: string) => void;
  onImageUpload?: (imageData: string) => void;
  onGenerate?: () => void;
  isGenerating?: boolean;
  confidence?: number;
}

export const DesignInput: React.FC<DesignInputProps> = ({
  onFigmaLink,
  onImageUpload,
  onGenerate,
  isGenerating = false,
  confidence,
}) => {
  const [mode, setMode] = useState<'figma' | 'image'>('image');
  const [figmaLink, setFigmaLink] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = e.dataTransfer.files;
    if (files && files[0]) {
      handleFile(files[0]);
    }
  }, []);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setPreview(result);
      onImageUpload?.(result);
    };
    reader.readAsDataURL(file);
  };

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          handleFile(blob);
        }
      }
    }
  }, []);

  React.useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  const handleFigmaSubmit = () => {
    if (figmaLink.includes('figma.com')) {
      onFigmaLink?.(figmaLink);
    }
  };

  return (
    <div className="design-input-container space-y-4">
      <div className="flex gap-2">
        <button
          onClick={() => setMode('image')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === 'image'
              ? 'bg-primary text-white'
              : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
          }`}
        >
          Upload Image
        </button>
        <button
          onClick={() => setMode('figma')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === 'figma'
              ? 'bg-primary text-white'
              : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
          }`}
        >
          Figma Link
        </button>
      </div>

      {mode === 'image' ? (
        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            dragActive ? 'border-primary bg-primary/10' : 'border-border'
          }`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />

          {preview ? (
            <div className="relative">
              <img
                src={preview}
                alt="Preview"
                className="max-h-64 mx-auto rounded-lg"
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPreview(null);
                }}
                className="absolute top-2 right-2 p-1 bg-black/50 rounded-full text-white hover:bg-black/70"
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-4xl">📁</div>
              <p className="text-sm text-muted-foreground">
                Drag & drop an image here, or click to browse
              </p>
              <p className="text-xs text-muted-foreground">
                Supports screenshots, mockups, wireframes
              </p>
              <p className="text-xs text-muted-foreground">
                Paste from clipboard with Ctrl+V
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <Input
            placeholder="Paste Figma link..."
            value={figmaLink}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFigmaLink(e.target.value)}
            className="w-full"
          />
          {figmaLink && figmaLink.includes('figma.com') && (
            <Button onClick={handleFigmaSubmit} className="w-full">
              Analyze Figma Design
            </Button>
          )}
        </div>
      )}

      {(preview || figmaLink) && (
        <div className="space-y-3">
          {confidence !== undefined && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    confidence >= 85 ? 'bg-green-500' : confidence >= 70 ? 'bg-yellow-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${confidence}%` }}
                />
              </div>
              <span className="text-sm text-muted-foreground">
                {confidence.toFixed(0)}% match
              </span>
            </div>
          )}

          <Button
            onClick={onGenerate}
            disabled={isGenerating}
            className="w-full"
          >
            {isGenerating ? (
              <>
                <span className="animate-spin mr-2">⏳</span>
                Generating UI...
              </>
            ) : (
              'Generate UI Code'
            )}
          </Button>
        </div>
      )}

      <div className="text-xs text-muted-foreground space-y-1">
        <p>Supported: PNG, JPG, WebP, Figma designs</p>
        <p>Output: React + Tailwind CSS + TypeScript</p>
      </div>
    </div>
  );
};

export default DesignInput;