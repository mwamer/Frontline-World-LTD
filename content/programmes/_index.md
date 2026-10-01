---
title: "Programmes"
summary: "Learning pathways from the Frontline World Training Academy."
# The pages in this folder are generated: content/programmes/_content.gotmpl makes
# one page per record in data/programmes/, and layouts/programmes/single.html lays
# them out. This file is the section's own index, and it is the only hand-written
# file in the folder.
#
# The empty_state message is what this page shows when the catalogue holds no
# record. It is not showing, because the catalogue holds records, but the
# mechanism stays: a section index that renders an empty <ul> is worse than one
# that says why it is empty. The copy lives here rather than in the layout, so it
# sits with the rest of the page's content and the template stays structural.
# layouts/programmes/list.html picks the message up and swaps it for the real
# list as soon as a record exists.
#
# Sitemap: on. The section is public and carries a Programmes item in the site
# navigation, so it is indexed like any other section.
#
# The two settings that once withheld this section and its generated pages from
# the sitemap have both been removed now that the catalogue is promoted. See
# content/programmes/_content.gotmpl for the matching removal on each programme
# page.
#
# build.render is deliberately not set: unlike the courses and people nodes, this
# one is meant to be generated. build.list is not set either, which would drop the
# programme pages out of the listings and the home page RSS feed.
empty_state: "Programmes are being prepared and will be listed here as soon as they are published. In the meantime, the Training Academy's courses are available individually."
---
<p>Programmes group related courses into a single learning pathway. Each programme gathers the courses that belong to it, so you can see the whole pathway before you choose a course.</p>
