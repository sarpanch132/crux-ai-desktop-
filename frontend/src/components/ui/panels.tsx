import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ResizableProps {
  direction: 'row' | 'column';
  sizes: number[];
  minSizes?: number[];
  onResize?: (sizes: number[]) => void;
  children: React.ReactNode[];
  className?: string;
}

export function ResizablePanels({ 
  direction = 'row', 
  sizes, 
  minSizes,
  onResize,
  children,
  className 
}: ResizableProps) {
  const [localSizes, setLocalSizes] = useState(sizes);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizing = useRef<number | null>(null);

  useEffect(() => {
    setLocalSizes(sizes);
  }, [sizes]);

  const handleResizeStart = (index: number, e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = index;
    document.body.style.cursor = direction === 'row' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (resizing.current === null || !containerRef.current) return;
      
      const rect = containerRef.current.getBoundingClientRect();
      const pos = direction === 'row' ? e.clientX - rect.left : e.clientY - rect.top;
      
      let prevTotal = 0;
      for (let i = 0; i < resizing.current; i++) prevTotal += localSizes[i];
      
      const newSize = Math.max(minSizes?.[resizing.current] || 100, pos - prevTotal);
      const delta = newSize - localSizes[resizing.current];
      
      if (Math.abs(delta) > 2) {
        setLocalSizes(prev => {
          const next = [...prev];
          next[resizing.current!] = newSize;
          return next;
        });
        onResize?.(localSizes);
      }
    };

    const handleMouseUp = () => {
      resizing.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [direction, localSizes, minSizes, onResize]);

  const isRow = direction === 'row';

  return (
    <div ref={containerRef} className={`flex ${isRow ? 'flex-row' : 'flex-col'} ${className || ''}`}>
      {children.map((child, index) => (
        <div
          key={index}
          style={{
            [isRow ? 'width' : 'height']: localSizes[index],
            flexShrink: 0,
            overflow: 'hidden',
          }}
        >
          {child}
          {index < children.length - 1 && (
            <div
              className={`resizer-${direction} absolute z-50 hover:bg-primary/50 transition-colors`}
              style={{
                [isRow ? 'right' : 'bottom']: 0,
                top: isRow ? 0 : 'auto',
                bottom: isRow ? 'auto' : 0,
                left: isRow ? 'auto' : 0,
                width: isRow ? 4 : '100%',
                height: isRow ? '100%' : 4,
                cursor: isRow ? 'col-resize' : 'row-resize',
              }}
              onMouseDown={(e) => handleResizeStart(index, e)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

interface CollapsibleProps {
  isOpen: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Collapsible({ isOpen, children, className }: CollapsibleProps) {
  return (
    <AnimatePresence mode="wait">
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface PanelGroupProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
}

export function PanelGroup({ children, className, title }: PanelGroupProps) {
  return (
    <div className={`flex flex-col h-full bg-card ${className || ''}`}>
      {title && (
        <div className="px-3 py-2 border-b border-border">
          <h3 className="text-sm font-medium">{title}</h3>
        </div>
      )}
      {children}
    </div>
  );
}