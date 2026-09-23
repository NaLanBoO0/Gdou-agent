import { onBeforeUnmount } from "vue";

// 帧节流的视觉对齐调度（借鉴 dsh ui-conversation useThrottledVisualUpdate）：
// 在 intervalFrames 帧内合并多次请求，只应用最后一次，避免流式每 token 触发布局抖动
const DEFAULT_INTERVAL_FRAMES = 3;

/**
 * 返回一个稳定的调度函数：连续调用时以 rAF 逐帧倒计时，
 * 满 intervalFrames 帧后执行一次 update（读到的永远是最新状态）。
 * 组件卸载时自动取消挂起的帧回调。
 */
export function useThrottledVisualUpdate(
  update: () => void,
  intervalFrames: number = DEFAULT_INTERVAL_FRAMES,
): () => void {
  let frameHandle: number | null = null;

  onBeforeUnmount(() => {
    if (frameHandle === null) return;
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  });

  return () => {
    if (frameHandle !== null) return;
    let remainingFrames = intervalFrames;
    const advance = () => {
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        frameHandle = requestAnimationFrame(advance);
        return;
      }
      frameHandle = null;
      update();
    };
    frameHandle = requestAnimationFrame(advance);
  };
}
