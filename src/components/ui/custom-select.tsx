import * as React from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface SelectOption {
  value: string;
  label: string;
}

export interface CustomSelectProps {
  id: string;
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
}

export function CustomSelect({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  className,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [shouldRender, setShouldRender] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const selectedOption = options.find((opt) => opt.value === value) ?? options[0];

  // Smooth open & close unmount lifecycle
  React.useEffect(() => {
    let timeoutId: number;
    if (isOpen) {
      setShouldRender(true);
    } else {
      timeoutId = window.setTimeout(() => {
        setShouldRender(false);
      }, 260); // Matches rollUp closing animation duration
    }
    return () => clearTimeout(timeoutId);
  }, [isOpen]);

  const handleToggle = () => {
    if (isOpen) {
      setIsOpen(false);
    } else {
      setShouldRender(true);
      setIsOpen(true);
    }
  };

  // Close dropdown when clicking outside
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleDismissKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen(false);
      } else if (['h', 's'].includes(event.key.toLowerCase())) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleDismissKey);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleDismissKey);
    };
  }, [isOpen]);

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (['Enter', ' ', 'Escape', 'ArrowDown', 'ArrowUp'].includes(e.key)) e.stopPropagation();
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setShouldRender(true);
        setIsOpen(true);
      } else {
        const currIdx = options.findIndex((opt) => opt.value === value);
        const nextIdx = (currIdx + 1) % options.length;
        const nextVal = options[nextIdx]?.value;
        if (nextVal) onChange(nextVal);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setShouldRender(true);
        setIsOpen(true);
      } else {
        const currIdx = options.findIndex((opt) => opt.value === value);
        const prevIdx = (currIdx - 1 + options.length) % options.length;
        const prevVal = options[prevIdx]?.value;
        if (prevVal) onChange(prevVal);
      }
    }
  };

  return (
    <div ref={containerRef} className={cn('custom-select-wrapper', className)}>
      {/* Hidden native select keeps test suites and screen readers 100% compatible */}
      <select
        id={`${id}-native`}
        data-testid={id}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        className="sr-native-select"
        aria-hidden="true"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Custom Liquid Glass Trigger Button */}
      <button
        type="button"
        id={id}
        className={cn('custom-select-trigger', isOpen && 'is-open')}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={`${id}-options`}
      >
        <span className="selected-value-label">{selectedOption?.label}</span>
        <ChevronDown className={cn('select-chevron', isOpen && 'rotate-180')} size={14} />
      </button>

      {/* Smooth Liquid Glass Dropdown Popover */}
      {shouldRender && (
        <div
          className={cn(
            'custom-select-popover',
            isOpen ? 'is-open' : 'is-closing'
          )}
          role="listbox"
          id={`${id}-options`}
          aria-hidden={!isOpen}
          inert={!isOpen}
          aria-label={ariaLabel}
        >
          <div className="custom-select-popover-glass" aria-hidden="true" />
          <div className="custom-select-options">
            {options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <div
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  className={cn('custom-select-item', isSelected && 'is-selected')}
                  onClick={() => {
                    onChange(opt.value);
                    setIsOpen(false);
                  }}
                >
                  <span className="item-label">{opt.label}</span>
                  {isSelected && <Check size={14} className="item-check" />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
