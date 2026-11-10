import { Tabs } from '@chakra-ui/react';

/**
 * Small subtle tabs that pick what part of a module's settings is shown (mixer views,
 * colour balance ranges, tone channels): one row of 2xs text, sized to sit inline in a
 * panel. Fill with `CompactTab`s.
 */
export function CompactTabs<V extends string>({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: V;
  onChange: (value: V) => void;
  children: React.ReactNode;
}) {
  return (
    <Tabs.Root size="sm" variant="subtle" value={value} onValueChange={(d) => onChange(d.value as V)}>
      <Tabs.List aria-label={label} gap="0.5" minH="0" p="0" alignItems="center">
        {children}
      </Tabs.List>
    </Tabs.Root>
  );
}

export function CompactTab(props: Tabs.TriggerProps) {
  return <Tabs.Trigger h="5" px="1.5" textStyle="2xs" {...props} />;
}
