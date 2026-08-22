clean:
	rm -rf ukr/_posts/*
	rm -rf latin_25/_posts/*
	rm -rf eng/_posts/*
	rm -rf _site/*

serve:
	bundle exec jekyll serve --host=0.0.0.0 --livereload --open-url --watch

serve-network:
	bundle exec jekyll serve --host=192.168.0.55 --livereload --open-url --watch
