import { useState, useCallback, useRef, useEffect } from 'react';

interface PanelConfig {
  id: string;
  defaultSize: number;
  minSize: number;
  maxSize: number;
}

interface UsePanelResizerResult {
  sizes: number[];
  containerRef: React.RefObject<HTMLDivElement>;
  startResize: (index: number) => void;
}

export function usePanelResizer(
  panels: PanelConfig[],
  direction: 'horizontal' | 'vertical'
): UsePanelResizerResult {
  const [sizes, setSizes] = useState<number[]>(panels.map(p => p.defaultSize));
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingIndex = useRef<number | null>(null);
  const startPos = useRef(0);

  const startResize = useCallback((index: number) => {
    resizingIndex.current = index;
    startPos.current = direction === 'horizontal' 
      ? (direction === 'horizontal' ? window.innerWidth : window.innerHeight)
      : 0;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [direction]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (resizingIndex.current === null || !containerRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();
      const currentPos = direction === 'horizontal' ? e.clientX - containerRect.left : e.clientY - containerRect.top;
      const index = resizingIndex.current;
      
      let newSize = currentPos;
      for (let i = 0; i < index; i++) {
        newSize -= sizes[i];
      }
      newSize = Math.max(panels[index].minSize, Math.min(panels[index].maxSize, newSize));

      setSizes(prev => {
        const next = [...prev];
        next[index] = newSize;
        return next;
      });
    };

    const handleMouseUp = () => {
      resizingIndex.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [direction, sizes, panels]);

  return { sizes, containerRef, startResize };
}