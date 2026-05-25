<script lang="ts">
  import { ICON, type IconKey } from './icons';
  interface Props {
    name: IconKey;
    size?: number;
    strokeWidth?: number;
  }
  let { name, size = 22, strokeWidth = 2 }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d={ICON[name]} />
</svg>
