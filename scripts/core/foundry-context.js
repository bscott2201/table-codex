export function getFoundryWorldContext() {
  try {
    return {
      foundryWorldId: game?.world?.id ?? null,
      foundryWorldTitle: game?.world?.title ?? null,
      foundryVersion: game?.version ?? null,
      systemId: game?.system?.id ?? null,
      systemTitle: game?.system?.title ?? null,
      systemVersion: game?.system?.version ?? null,
    };
  } catch {
    return {
      foundryWorldId: null,
      foundryWorldTitle: null,
      foundryVersion: null,
      systemId: null,
      systemTitle: null,
      systemVersion: null,
    };
  }
}

export function getCurrentSceneRef() {
  try {
    const scene = canvas?.scene ?? game?.scenes?.active ?? null;
    if (!scene) return null;
    return { id: scene.id ?? null, name: scene.name ?? null };
  } catch {
    return null;
  }
}

export function getCurrentUserRef() {
  try {
    const user = game?.user ?? null;
    if (!user) return null;
    return {
      id: user.id ?? null,
      name: user.name ?? null,
      isGM: user.isGM ?? false,
    };
  } catch {
    return null;
  }
}

export function isGM() {
  try {
    return game?.user?.isGM === true;
  } catch {
    return false;
  }
}
