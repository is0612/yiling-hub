/**
 * Session guard for the whole app. /login is the only public page; everything else requires an
 * authenticated (or explicitly enabled local-development) identity.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const { state, refresh } = useAuthSession();
  if (!state.value.loaded) {
    const headers = import.meta.server ? useRequestHeaders(["cookie"]) : undefined;
    await refresh(headers);
  }

  if (!state.value.user && to.path !== "/login") {
    return navigateTo("/login");
  }
  if (state.value.user && to.path === "/login") {
    return navigateTo("/");
  }
});
