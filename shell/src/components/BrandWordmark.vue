<script setup lang="ts">
import logo from "../assets/gdouwork-logo.png";
</script>

<template>
  <span class="brand-wordmark">
    <img :src="logo" alt="Gdouwork" draggable="false" />
  </span>
</template>

<style>
.brand-wordmark {
  display: block;
  max-width: 100%;
  line-height: 0;
}

.brand-wordmark img {
  display: block;
  height: 36px;
  width: auto;
  max-width: 100%;
}

/* The logotype is black; on a dark sidebar it needs a light backing to stay
   readable, so dark mode gives it a small white chip. */
:root[data-app-theme="dark"] .brand-wordmark img {
  padding: 5px 14px;
  border-radius: 10px;
  background: #ffffff;
  box-sizing: border-box;
  height: 46px;
}
</style>
