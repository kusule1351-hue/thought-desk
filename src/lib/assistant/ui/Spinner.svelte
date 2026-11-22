<script lang="ts">
  /** A small ring that turns while something runs; a still, partial ring when motion is reduced. */
  let { size = 12, label }: { size?: number; label: string } = $props();
</script>

<span class="spinner" role="img" aria-label={label} style:width="{size}px" style:height="{size}px"></span>

<style>
  .spinner {
    display: inline-block;
    flex: none;
    box-sizing: border-box;
    border-radius: 50%;
    border: 1.5px solid var(--text-4);
    border-top-color: var(--text-2);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
