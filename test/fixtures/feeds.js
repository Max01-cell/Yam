// Verbatim excerpts from real published feeds, taken from the MIT-licensed
// fixture corpus of rss-parser (github.com/rbren/rss-parser, test/input).
// These are the actual container shapes the harvester has to survive: one image
// offered at several widths, tracking beacons dressed as <img>, feed branding,
// sub-300px thumbnails, and img tags that arrive entity-escaped.

export const REAL = {
  "guardianVariants": "<media:content width=\"140\" url=\"https://i.guim.co.uk/img/media/b73c8752cd4667c923dff7f1542f1fb20089e421/0_108_3000_1799/master/3000.jpg?w=140&amp;q=55&amp;auto=format&amp;usm=12&amp;fit=max&amp;s=0a4f729a1784060437ae689bc8d26534\"><media:content width=\"460\" url=\"https://i.guim.co.uk/img/media/b73c8752cd4667c923dff7f1542f1fb20089e421/0_108_3000_1799/master/3000.jpg?w=460&amp;q=55&amp;auto=format&amp;usm=12&amp;fit=max&amp;s=a606a273a90104e57b1e09bc4c0a1e11\">",
  "mediumBeacon": "<img src=\"https://medium.com/_/stat?event=post.clientViewed&referrerSource=full_rss&postId=125af37d838f\" width=\"1\" height=\"1\">",
  "mediumContent": "<img alt=\"\" src=\"https://cdn-images-1.medium.com/max/938/1*C_nVpehD-NKBgtVEULabmQ.jpeg\" />",
  "redditThumb": "<media:thumbnail url=\"https://b.thumbs.redditmedia.com/z4zzFBqZ54WT-rFfKXVor4EraZtJVw7AodDvOZ7kitQ.jpg\" />",
  "redditBranding": "<image><url>https://www.redditstatic.com/reddit.com.header.png</url><title>reddit: the front page of the internet</title>",
  "heiseScaled": "<img src=\"http://www.heise.de/scale/geometry/264/q80/imgs/18/1/7/3/9/9/2/1/wildfly-2bf4ffd2935e38b6-90200def80b152e9-5ba35d3770232d92.jpeg\" alt=\"WildFly 10\" />",
  "uolDimensioned": "<img src='https://conteudo.imguol.com.br/c/noticias/5f/2018/09/17/presidenciaveis-1537211917356_142x100.jpg' align=\"left\" />",
  "escapedImg": "&lt;img src=\"http://feeds.feedburner.com/~ff/blogspot/RLXA?d=yIl2AUoC8zA\" border=\"0\"&gt;"
};
