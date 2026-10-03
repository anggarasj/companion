import type { TimelineItem } from '@meetcc/shared'

interface Props {
  timeline: TimelineItem[]
  selected: Set<number>
  indeterminate?: Set<number>
  disabled: boolean
  onToggle: (index: number, checked: boolean) => void
}

export function TimelineScopeList({ timeline, selected, indeterminate, disabled, onToggle }: Props) {
  return (
    <div className="doc-scope-list">
      {timeline.map((item, index) => (
        <label key={`${item.time}-${index}`}>
          <input
            type="checkbox"
            checked={selected.has(index)}
            ref={(input) => {
              if (input) input.indeterminate = indeterminate?.has(index) ?? false
            }}
            disabled={disabled}
            onChange={(event) => onToggle(index, event.target.checked)}
          />
          <span>
            <strong>{item.time || '—'}</strong> {item.topic}
          </span>
        </label>
      ))}
    </div>
  )
}
