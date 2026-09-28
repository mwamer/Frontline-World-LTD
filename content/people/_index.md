---
# The people in this folder are generated: content/people/_content.gotmpl makes
# one profile page per public record in data/associates/, and
# layouts/people/single.html lays them out. There is no page of its own here,
# and there is deliberately no /people/ index — the directory that lists
# everyone is the Our People page at /our-people/, and each profile links back
# to it.
#
# Hugo still builds a section node for the folder, and a section node lands in
# the sitemap, which would advertise a /people/ URL that is never generated.
# Two front matter keys fix that, and nothing outside this file changes:
# sitemap.disable keeps the node out of the sitemap, and build.render stops
# Hugo rendering an empty page for it. The site-wide output settings are left
# alone, so the Insights section keeps its RSS feed and its own sitemap entry.
#
# build.list is deliberately not set: `never` here would also drop the profile
# pages out of the listings and the home page RSS feed.
sitemap:
  disable: true
build:
  render: never
title: "Associate profiles"
---
