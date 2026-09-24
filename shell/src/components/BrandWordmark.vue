<template>
  <span class="brand-wordmark">
    <!-- 纯文字字标：不再走图片，天然不带任何底色，切换主题/工作台背景都不会有白块 -->
    <span class="brand-wordmark__text">Gdouwork</span>
  </span>
</template>

<style>
.brand-wordmark {
  display: block;
  line-height: 0;
}

.brand-wordmark__text {
  display: inline-block;
  height: 36px;
  line-height: 36px;
  font-weight: 700;
  font-size: 20px;
  letter-spacing: -0.02em;
  color: currentColor;
}
</style>