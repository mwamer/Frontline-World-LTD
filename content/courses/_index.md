---
# The six course files in this folder are not published under /courses/: each
# one sets url to /training-academy/courses/<slug>/, because the site's public
# training landing page is /training-academy/. This folder is a container, not
# a page.
#
# Hugo still builds a section node for the folder. That node has no list
# template, so the build warns about a missing layout, and the node would be
# advertised in the sitemap as a /courses/ URL that is never generated. Two
# front matter keys fix both, and nothing outside this folder changes:
# build.render stops Hugo rendering a page for the node, and sitemap.disable
# keeps it out of the sitemap.
#
# /courses/ itself is not a dead end: the alias in content/training-academy.html
# sends that URL to the Training Academy page, so the folder keeps one canonical
# public URL and does not gain a second course listing.
#
# build.list is deliberately not set: `never` here would also drop the course
# pages out of the listings and the home page RSS feed.
sitemap:
  disable: true
build:
  render: never
title: "Courses"
---
