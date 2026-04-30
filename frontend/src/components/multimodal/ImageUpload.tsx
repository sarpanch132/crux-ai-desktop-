import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from '../ui/button';

interface ImageUploadProps {
  onImageUpload: (imageData: string, type: 'upload' | 'clipboard' | 'screenshot') => void;
}

export const ImageUpload: React.FC<ImageUploadProps> = ({
  onImageUpload,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            processFile(blob, 'clipboard');
          }
        }
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, []);

  const processFile = async (file: File, type: 'upload' | 'clipboard' | 'screenshot') => {
    setError(null);

    // File size limit: 10MB
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large. Maximum size is 10MB');
      return;
    }

    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
    if (!validTypes.includes(file.type)) {
      setError('Invalid file type. Supported: JPEG, PNG, GIF, WebP, BMP');
      return;
    }

    setUploadProgress(0);

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setPreview(result);
      setUploadProgress(100);
      onImageUpload(result, type);
    };
    reader.onerror = () => {
      setError('Failed to read file');
      setUploadProgress(null);
    };
    reader.readAsDataURL(file);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      processFile(files[0], 'upload');
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      processFile(files[0], 'upload');
    }
  }, []);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const clearPreview = () => {
    setPreview(null);
    setUploadProgress(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="image-upload-container">
      <div
        className={`drop-zone ${isDragging ? 'dragging' : ''} ${preview ? 'has-preview' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          border: '2px dashed var(--border)',
          borderRadius: '8px',
          padding: '24px',
          textAlign: 'center',
          transition: 'all 0.2s ease',
          background: isDragging ? 'var(--primary/10)' : 'transparent',
          cursor: 'pointer',
        }}
        onClick={!preview ? handleUploadClick : undefined}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

         {preview ? (
          <div className="preview-container">
            <img
              src={preview}
              alt="Preview"
              style={{
                maxWidth: '100%',
                maxHeight: '300px',
                borderRadius: '8px',
                objectFit: 'contain',
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                clearPreview();
              }}
              style={{ marginTop: '12px' }}
            >
              Remove Image
            </Button>
          </div>
        ) : (
          <div className="upload-prompt">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              style={{ margin: '0 auto 12px', opacity: 0.5 }}
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p style={{ color: 'var(--muted-foreground)', fontSize: '14px', marginBottom: '8px' }}>
              Drag and drop an image here
            </p>
            <p style={{ color: 'var(--muted-foreground)', fontSize: '12px' }}>
              or click to browse
            </p>
            <p style={{ color: 'var(--muted-foreground)', fontSize: '11px', marginTop: '12px' }}>
              Supports: JPEG, PNG, GIF, WebP, BMP
            </p>
            <p style={{ color: 'var(--muted-foreground)', fontSize: '11px' }}>
              Ctrl+V to paste from clipboard
            </p>
          </div>
        )}
      </div>

      {uploadProgress !== null && uploadProgress < 100 && (
        <div style={{ marginTop: '8px' }}>
          <div
            style={{
              height: '4px',
              background: 'var(--secondary)',
              borderRadius: '2px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${uploadProgress}%`,
                background: 'var(--primary)',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: '8px',
            padding: '8px 12px',
            background: 'var(--destructive/10)',
            borderRadius: '4px',
            color: 'var(--destructive)',
            fontSize: '13px',
          }}
        >
          {error}
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default ImageUpload;