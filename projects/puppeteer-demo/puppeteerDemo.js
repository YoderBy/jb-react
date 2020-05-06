jb.ns('puppeteerDemo')

jb.component('dataResource.events', {
  watchableData: [
    
  ]
})

jb.component('puppeteerDemo.main', {
  type: 'control',
  impl: group({
    controls: [
      group({
        title: '',
        layout: layout.flex({alignItems: 'baseline', spacing: '10'}),
        controls: [
          editableText({title: 'query', databind: '%$query%'}),
          button({
            title: 'refresh server code',
            action: pptr.sendCodeToServer(),
            raised: 'true'
          }),
          button({
            title: 'search',
            action: pptr.session({
              showBrowser: true,
              databindEvents: '%$events%',
              actions: [pptr.gotoPage('http://www.google.com/'), pptr.extractBySelector('.fld__Label3')]
            }),
            raised: 'true'
          })
        ],
        features: variable({
          name: 'pptrSession',
          value: pptr.session({showBrowser: true, databindEvents: []})
        })
      }),
      itemlist({
        items: '%$events%',
        controls: [
          text({text: json.stringify('%%')})
        ],
        features: watchRef({ref: '%$events%', includeChildren: 'yes'})
      }),
      group({
        controls: [
          image({url: pipeline('%$url/1%'), width: '595', height: '343'})
        ],
        features: group.wait({
          for: {
            '$': 'pptr.htmlFromPage',
            '$byValue': [
              {
                '$': 'pptr.headlessPage',
                url: 'http://www.google.com',
                extract: {'$': 'pptr.extractContent', selector: 'img', extract: 'src', multiple: true},
                features: pptr.waitForSelector('img'),
                showBrowser: true
              }
            ]
          },
          varName: 'url'
        })
      })
    ]
  })
})

jb.component('dataResource.query', {
  watchableData: 'vitamins'
})
