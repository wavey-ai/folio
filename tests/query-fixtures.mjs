export function recursiveQueryLeaves() {
  const leaves = [];
  function record(id, parentId, name, fields = {}) {
    leaves.push({ id, parent_id: parentId, name: "_tree", path: "", data_type: "tree", value: name });
    for (const [path, value] of Object.entries(fields)) {
      leaves.push({ id, parent_id: parentId, name, path, data_type: typeof value, value: String(value) });
    }
  }

  record("document", null, "document");
  record("item-1", "document", "document__items", { name: "First", amount: 125.5 });
  record("item-2", "document", "document__items", { name: "Second", amount: 80 });
  record("container", "item-1", "document__items__container");
  record("child-1", "container", "document__items__children", { name: "Deep child", note: "Second scalar" });
  record("child-2", "item-2", "document__items__children", { name: "Direct child" });

  const release = "discogs_releases__release";
  record("discogs", null, "discogs_releases");
  for (const number of [1, 3]) {
    record(`release-${number}`, "discogs", release, {
      "artists__artist__name": "Wavey Artist",
      "genres__genre": "Electronic",
      "labels__label__@name": "Wavey Records",
      "styles__style": number === 1 ? "Deep House" : "Ambient",
      "tracklist__track__title": `Track ${number}`,
    });
  }
  record("release-2", "discogs", release, { title: "Nested release" });
  record("music", "release-2", `${release}__music`);
  record("music-inner", "music", `${release}__music__inner`);
  record("artist", "music-inner", `${release}__artists__artist`, { name: "Wavey Artist", role: "Main" });
  record("genre", "music-inner", `${release}__genres__genre`, { value: "Electronic" });
  record("label", "music-inner", `${release}__labels__label`, { "@name": "Moon Records" });
  record("style-1", "music-inner", `${release}__styles__style`, { value: "Techno" });
  record("style-2", "music-inner", `${release}__styles__style`, { value: "Ambient" });
  record("track-1", "music-inner", `${release}__tracklist__track`, { title: "Second Track", duration: "3:30" });
  record("track-2", "music-inner", `${release}__tracklist__track`, { title: "Third Track" });
  record("release-4", "discogs", release, {
    "artists__artist__name": "Wavey Artist",
    "genres__genre": "Rock",
    "tracklist__track__title": "Excluded track",
  });
  return leaves;
}

export const expectedArtistOverview = [{
  artist: "Wavey Artist",
  release_count: 3,
  track_count: 4,
  label_count: 2,
  labels: "Moon Records, Wavey Records",
  styles: "Ambient, Deep House, Techno",
}];
