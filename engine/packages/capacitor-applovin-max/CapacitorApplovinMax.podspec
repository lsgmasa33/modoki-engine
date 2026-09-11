require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorApplovinMax'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/nicemogames/capacitor-applovin-max'
  s.author = ''
  s.source = { :git => 'https://github.com/nicemogames/capacitor-applovin-max.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.dependency 'AppLovinSDK', '~> 13.0'
  s.swift_version = '5.9'
end
