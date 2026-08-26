import { strToU8, zipSync } from "fflate";

export function makeTocEpub(): Uint8Array {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
      <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
      </container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>源目录测试书</dc:title><dc:creator>测试作者</dc:creator>
          <dc:language>zh-CN</dc:language><dc:identifier id="BookId">toc-test</dc:identifier>
        </metadata>
        <manifest>
          <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
          <item id="ch12" href="chapter12.xhtml" media-type="application/xhtml+xml"/>
          <item id="ch3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine toc="ncx"><itemref idref="ch12"/><itemref idref="ch3"/></spine>
      </package>`),
    "OEBPS/toc.ncx": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
        <head><meta name="dtb:uid" content="toc-test"/></head><docTitle><text>源目录测试书</text></docTitle>
        <navMap>
          <navPoint id="v1" playOrder="1"><navLabel><text>第一卷 起航</text></navLabel><content src="chapter12.xhtml#c1"/>
            <navPoint id="c1" playOrder="2"><navLabel><text>第一章 海风</text></navLabel><content src="chapter12.xhtml#c1"/></navPoint>
            <navPoint id="c2" playOrder="3"><navLabel><text>第二章 星光</text></navLabel><content src="chapter12.xhtml#c2"/></navPoint>
          </navPoint>
          <navPoint id="v2" playOrder="4"><navLabel><text>第二卷 归途</text></navLabel><content src="chapter3.xhtml#c3"/>
            <navPoint id="c3" playOrder="5"><navLabel><text>第三章 回港</text></navLabel><content src="chapter3.xhtml#c3"/></navPoint>
          </navPoint>
        </navMap>
      </ncx>`),
    "OEBPS/chapter12.xhtml": strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>合并正文</title></head><body><section id="c1"><h1>旧标题一</h1><p>第一章正文。</p></section><section id="c2"><h1>旧标题二</h1><p>第二章正文。</p></section></body></html>`),
    "OEBPS/chapter3.xhtml": strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>旧标题三</title></head><body><section id="c3"><h1>旧标题三</h1><p>第三章正文。</p></section></body></html>`),
  };
  return zipSync(files, { level: 0 });
}
