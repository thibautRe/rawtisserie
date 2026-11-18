import { CloseButton, Input, InputGroup } from '@chakra-ui/react';
import { Search } from 'lucide-react';

/**
 * Finds tags in a tree (`filterTagTree` does the finding): the tag manager's, the
 * library's filters. Escape empties it.
 */
export function TagSearch({
  value,
  onChange,
  size = 'sm',
  placeholder = 'Find a tag…',
  ...rest
}: {
  value: string;
  onChange: (query: string) => void;
  size?: 'xs' | 'sm';
  placeholder?: string;
  maxW?: string;
}) {
  return (
    <InputGroup
      startElement={<Search size={size === 'xs' ? 12 : 14} />}
      endElement={
        value ? <CloseButton size="2xs" me="-1.5" aria-label="Clear the search" onClick={() => onChange('')} /> : null
      }
      {...rest}
    >
      <Input
        size={size}
        placeholder={placeholder}
        aria-label={placeholder.replace(/…$/, '')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
    </InputGroup>
  );
}
