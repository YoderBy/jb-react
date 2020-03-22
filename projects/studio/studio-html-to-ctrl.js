jb.component('studio.dropHtml', {
  params: [
    {id: 'onDrop', type: 'action', dynamic: true, description: 'use %$newCtrl%'}
  ],
  type: 'feature',
  impl: features(
    htmlAttribute('ondragover', 'over'),
    htmlAttribute('ondrop', 'dropHtml'),
    defHandler('over', (ctx,{ev}) => ev.preventDefault()),
    defHandler(
        'dropHtml',
        (ctx,{cmp, ev},{onDrop}) => {
        ev.preventDefault();
        return Array.from(ev.dataTransfer.items).filter(x=>x.type.match(/html/))[0].getAsString(html =>
                onDrop(ctx.setVar('newCtrl',jb.ui.htmlToControl(html))))
      }
      )
  )
})

jb.component('studio.htmlToControl', {
  params: [
    {id: 'html', as: 'string'}
  ],
  impl: (ctx,html) => jb.ui.htmlToControl(html)
})

jb.ui.cssProcessors = {
    layout: {
        filter: prop => prop.match(/flex|grid|align/) ||
            ['display','order','top','left','right','bottom','box-sizing'].find(x=>prop.indexOf(x+':') == 0),
        features: props => css.layout(props.join(';'))
    },
    width: {
        filter: (prop,props) =>
            prop.match(/^(min-|max-)?width/) || prop.match(/overflow-x/) && props.find(x=>x.match(/^(min-|max-)?width/)),
        features: props => {
            const widthProp = props.filter(x=>x.match(/^(min-|max-)?width/))[0]
            const minMax = widthProp.match(/min/) ? 'min' : widthProp.match(/max/) ? 'max' : null
            const overflow = props.filter(x=>x.match(/overflow/)).map(x=>x.split(':').pop().trim())[0]
            return css.width({
                    width: widthProp.split(':').pop().replace(/px/,'').trim(),
                    ...(minMax && {minMax}),
                    ...(overflow && {overflow}),
                })
        }
    },
    height: {
        filter: (prop,props) =>
            prop.match(/^(min-|max-)?height/) || prop.match(/overflow-y/) && props.find(x=>x.match(/^(min-|max-)?height/)),
        features: props => {
            const heightProp = props.filter(x=>x.match(/^(min-|max-)?height/))[0]
            const minMax = heightProp.match(/min/) ? 'min' : heightProp.match(/max/) ? 'max' : null
            const overflow = props.filter(x=>x.match(/overflow/)).map(x=>x.split(':').pop().trim())[0]
            return css.height({
                    height: heightProp.split(':').pop().replace(/px/,'').trim(),
                    ...(minMax && {minMax}),
                    ...(overflow && {overflow}),
                })
        }
    },
    margin: {
        filter: x=>x.match(/margin:/),
        features: props => {
            if (props.length > 1)
                return [css.layout(props.join(';'))]
            const vals = props[0].split(':').pop().split(' ').filter(x=>x).map(x=>x.split('px')[0])
            const allZero = vals.reduce((agg,val) => agg && val == '0', true)
            if (allZero) return
            return vals.length == 1 ? css.marginAllSides(vals[0])
                : vals.length == 2 ? css.marginVerticalHorizontal(vals[0],vals[1])
                : vals.length == 3 ? css.margin({top: vals[0], right: vals[1], bottom: vals[2], left: vals[1] })
                : css.margin({top: vals[0], right: vals[1], bottom: vals[2], left: vals[3] })
        }
    },
    padding: {
        filter: x=>x.match(/padding:/),
        features: props => {
            if (props.length > 1)
                return [css(props.join(';'))]
            const vals = props[0].split(':').pop().split(' ').filter(x=>x).map(x=>x.split('px')[0])
            const allZero = vals.reduce((agg,val) => agg && val == '0', true)
            if (allZero) return
            return vals.length == 1 ? css.padding({top: vals[0], right: vals[0], bottom: vals[0], left: vals[0] })
                : vals.length == 2 ? css.padding({top: vals[0], right: vals[1], bottom: vals[0], left: vals[1] })
                : vals.length == 3 ? css.padding({top: vals[0], right: vals[1], bottom: vals[2], left: vals[1] })
                : css.padding({top: vals[0], right: vals[1], bottom: vals[2], left: vals[3] })
        }
    },
    typography: {
        filter: x => x.match(/font|text-/),
        features: props => css.typography(props.join(';'))
    },
}

jb.ui.htmlToControl = function(html) {
    const elem = document.createElement('div')
    elem.innerHTML = html
    clean(elem)
    return vdomToControl(elemToVdom(elem))

    function elemToVdom(elem) {
        if (elem.nodeType == Node.TEXT_NODE && elem.nodeValue.match(/^\s*$/)) return
        if (elem.nodeType == Node.TEXT_NODE) { // for mixed {
            return { elem, tag: 'span', attributes: { $text: elem.nodeValue.trim() } }
        }
        const singleTextChild = elem.childNodes.length == 1 && jb.path(elem,'firstChild.nodeName') == '#text' && elem.firstChild.nodeValue
        return {
            elem,
            tag: elem.tagName.toLowerCase(),
            attributes: jb.objFromEntries([
                ...Array.from(elem.attributes).map(e=>[e.name,e.value]),
                ...( singleTextChild ? [['$text',singleTextChild]] : [])
            ]),
            ...( (elem.childNodes[0] && !singleTextChild) && { children:
                Array.from(elem.childNodes).map(el=> elemToVdom(el)).filter(x=>x) })
        }
    }

    function clean(elem) {
        elem.setAttribute('class','')
        elem.setAttribute('style',(elem.getAttribute('style') ||'').split(';')
            .filter(x=>!x.match('inherit'))
            .filter(x=>!x.match(/^\s*border: 0px$/))
            .join(';'))
        Array.from(elem.children).forEach(e => clean(e))
    }

    function vdomToControl(vdom) {
        const atts = vdom.attributes || {}
        const tag = vdom.tag
        const styleCss = atts.style||''
        const props = styleCss.trim().split(';').map(x=>x.trim()).map(x=>x,replace(/\s*:\s*/g,':')).filter(x=>x)
        const featureProps = props.filter(x=> !x.match(/background-image|background-size/))

        const pt = vdom.children ? 'group'
            : (tag == 'button' || tag == 'a') ? 'button'
            : atts.$text ? 'text'
            : tag == 'img' ? 'image'
            : styleCss.indexOf('background-image') != -1 ? 'image'
            : 'group'
        const features = extractFeatures(), controls = extractControls(), style = extractStyle()
        return {$: pt,
            ...(style && {style}) ,
            ...(features && features.length && {features}),
            ...(controls && controls.length && {controls}),
            ...extractPTProps()
        }

        function extractFeatures() {
            const attfeatures = ['width','height','tabindex'].filter(att => atts[att])
                .map(att=> htmlAttribute(att,atts[att]))
            return [atts.class && css.class(atts.class), ...cssToFeatures(), ...attfeatures].filter(x=>x)
        }

        function cssToFeatures() {
            if (!styleCss) return []
            const res = Object.values(jb.ui.cssProcessors).reduce((agg,proc) => {
                const props4Features = agg.props.filter(p=>proc.filter(p,featureProps))
                const features = props4Features.length ? jb.asArray(proc.features(props4Features)).filter(x=>x) : []
                return {
                    props: agg.props.filter(p=>! proc.filter(p,featureProps)),
                    features: [...agg.features, ...features]
            }}, {props: featureProps, features: []})
            return res.features.concat([css(res.props.join(';'))])
        }

        function extractStyle() {
            if (jb.comps[pt+'.htmlTag']) // group & text
                return jb.frame[pt].htmlTag(tag)
            else if (tag == 'button')
                return button.native()
            else if (tag == 'a')
                return button.href()
            else if (tag == 'img')
                return image.img()
        }
        function extractControls() {
            return vdom.children && vdom.children.map(ch=>vdomToControl(ch))
        }
        function extractPTProps() {
            return {
                text: pt == 'text' && atts.$text,
                url: pt == 'image' && atts.src || bgImage(),
                resize: bgSize(),
                title: pt == 'button' && tag == 'a' && atts.$text ||
                       pt == 'group' && tag
            }
        }
        function bgImage() {
            return props.filter(x=> x.indexOf('background-image') != -1)
                .map(x=>x.replace(/^background-image\s*:\s*/,''))
                .map(x=>x.replace(/^url\(/,'')
                .replace(/^("|')/,'').replace(/("|')$/,''))[0]
        }
        function bgSize() {
            return props.filter(x=> x.indexOf('background-size') != -1)
                .map(x=>x.replace(/^background-size\s*:\s*/,''))
                .map(val => val == 'cover' ? image.cover()
                    : val == 'contain' ? image.fullyVisible()
                    : image.widthHeight(... val.split(' ').map(x=>x.trim().replace(/px/,'')))
                )[0]
        }
    }
}